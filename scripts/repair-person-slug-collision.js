// Un-merges every person who was collapsed onto a single Person row by the
// empty-slug bug in upsertPersonsByName().
//
//   node scripts/repair-person-slug-collision.js --dry-run     (do this first)
//   node scripts/repair-person-slug-collision.js
//
// The bug: personSlug was name.toLowerCase().replace(/[^a-z0-9]/g,'-')..., so a
// name with no ASCII letters or digits — Лев Толстой, 村田沙耶香, 夏目漱石 —
// reduced to "". Person.slug is unique, so the first such person inserted
// claimed that slug and every one after was upserted onto the same row, which
// `update: { name }` then renamed to whoever arrived last. The result was one
// Person holding 51 books, 60 screen credits and 17 directing credits under a
// single Japanese novelist's name: Tolstoy, Homer, Liu Cixin, Murakami and
// Solzhenitsyn among them.
//
// mediaHelpers.js is fixed, so nothing new collapses. This repairs what already
// did.
//
// The original names are NOT recoverable from our own database — each one was
// overwritten by the next. They have to come back from the source that supplied
// them: Open Library for a book's authors (via goodreadsId, which holds the OL
// work id), TMDB for screen cast and directors (via tmdbId). Anything with no
// source id is reported and left alone rather than guessed at.
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { connectPersons } = require('../src/lib/mediaHelpers');
const { getTmdbDetail, getOpenLibraryDetail, getTvSeasonCast } = require('../src/services/mediaLookup');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const PACE_MS = 350;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The exact rule that produced the collision — a name is affected if and only
// if this returns empty. Kept here verbatim rather than imported, because
// mediaHelpers no longer does this and never should again.
const asciiSlug = name =>
  String(name).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const wasCollapsed = name => asciiSlug(name) === '';

const REL = {
  authors:   { field: 'authors',   label: 'author' },
  cast:      { field: 'cast',      label: 'cast' },
  directors: { field: 'directors', label: 'director' },
};

async function sourceNames(item, rel) {
  if (item.mediaType === 'BOOK') {
    if (rel !== 'authors' || !item.goodreadsId) return null;
    if (!/^OL\d+W$/.test(item.goodreadsId)) return null; // a Google Books volume id is no use here
    const d = await getOpenLibraryDetail(item.goodreadsId);
    return d?.authors || [];
  }
  // A TV season row carries no tmdbId of its own — the id lives on the parent
  // show, and the season's cast comes from TMDB's season endpoint. Without this
  // the five season rows in the affected set had no recoverable source at all.
  if (!item.tmdbId && item.parentId && item.parent?.tmdbId && item.seasonNumber != null) {
    if (rel !== 'cast') return null;
    const s = await getTvSeasonCast(item.parent.tmdbId, item.seasonNumber);
    return s?.cast || null;
  }

  if (!item.tmdbId) return null;
  const type = item.mediaType === 'TV_SHOW' ? 'tv' : 'movie';
  const d = await getTmdbDetail(item.tmdbId, type);
  if (!d) return null;
  return rel === 'cast' ? (d.cast || []) : (d.directors || []);
}

(async () => {
  const bogus = await prisma.person.findFirst({ where: { slug: '' }, select: { id: true, name: true } });
  if (!bogus) { console.log('No empty-slug Person row — nothing to repair.'); await prisma.$disconnect(); return; }

  console.log(`collapsed Person: ${JSON.stringify(bogus.name)} (${bogus.id})`);
  console.log(DRY ? 'DRY RUN — no writes\n' : 'WRITING\n');

  const stats = { fixed: 0, noSource: 0, noNonLatin: 0, failed: 0, peopleCreated: new Set() };

  for (const rel of Object.keys(REL)) {
    const items = await prisma.mediaItem.findMany({
      where: { [rel]: { some: { id: bogus.id } } },
      select: { id: true, title: true, mediaType: true, tmdbId: true, goodreadsId: true, castOrder: true,
                seasonNumber: true, parentId: true, parent: { select: { tmdbId: true } } },
      orderBy: { title: 'asc' },
    });
    if (!items.length) continue;
    console.log(`── ${rel}: ${items.length} items`);

    for (const item of items) {
      let names;
      try {
        names = await sourceNames(item, rel);
      } catch (err) {
        stats.failed++;
        console.log(`   ✗ ${item.title.slice(0, 40)} — lookup failed: ${err.message.split('\n')[0]}`);
        await sleep(PACE_MS);
        continue;
      }
      await sleep(PACE_MS);

      if (names === null) {
        stats.noSource++;
        console.log(`   ? ${item.title.slice(0, 40).padEnd(41)} no usable source id — left alone`);
        continue;
      }

      const real = names.filter(wasCollapsed);
      if (!real.length) {
        // The source no longer lists a non-Latin name here — the credit drifted,
        // or TMDB switched to a romanized spelling. Detaching the wrong person is
        // still right; we just have nobody to put in their place.
        stats.noNonLatin++;
        console.log(`   − ${item.title.slice(0, 40).padEnd(41)} source has no non-Latin ${REL[rel].label} — detaching only`);
        if (!DRY) {
          await prisma.mediaItem.update({
            where: { id: item.id },
            data: { [rel]: { disconnect: { id: bogus.id } } },
          });
          if (rel === 'cast' && item.castOrder?.length) {
            await prisma.mediaItem.update({
              where: { id: item.id },
              data: { castOrder: item.castOrder.filter(id => id !== bogus.id) },
            });
          }
        }
        continue;
      }

      console.log(`   ✓ ${item.title.slice(0, 40).padEnd(41)} ${real.join(', ')}`);
      real.forEach(n => stats.peopleCreated.add(n));
      stats.fixed++;
      if (DRY) continue;

      // connectPersons runs through the FIXED slug rule, so each of these gets
      // its own Person row keyed on a hash of the name.
      const payload = await connectPersons(real);
      const connectedIds = payload.connect.map(c => c.id);

      await prisma.mediaItem.update({
        where: { id: item.id },
        data: { [rel]: { disconnect: { id: bogus.id }, ...payload } },
      });

      // castOrder is a parallel array of ids carrying billing order; the bogus
      // id occupies the slot the real actor should be in. Splice rather than
      // append, or the person lands at the bottom of the billing list.
      if (rel === 'cast' && item.castOrder?.length) {
        const at = item.castOrder.indexOf(bogus.id);
        if (at >= 0) {
          const next = [...item.castOrder];
          next.splice(at, 1, ...connectedIds);
          await prisma.mediaItem.update({
            where: { id: item.id },
            data: { castOrder: [...new Set(next)] },
          });
        }
      }
    }
  }

  console.log(`\nrepaired ${stats.fixed} credits · ${stats.peopleCreated.size} distinct real people recovered`);
  console.log(`no source id ${stats.noSource} · source had no non-Latin name ${stats.noNonLatin} · lookup failures ${stats.failed}`);

  if (!DRY) {
    const left = await prisma.mediaItem.count({
      where: { OR: [{ authors: { some: { id: bogus.id } } }, { cast: { some: { id: bogus.id } } }, { directors: { some: { id: bogus.id } } }] },
    });
    console.log(`credits still attached to the collapsed row: ${left}`);
    if (left === 0) {
      // Deliberately NOT deleted automatically even at zero: the row is a real
      // person (whoever was imported last) and may legitimately be re-created
      // with a correct slug by the next import. Left for a human to look at.
      console.log(`The collapsed row is now unreferenced. Re-import or rename it by hand if ${JSON.stringify(bogus.name)} should exist as a person.`);
    }
  }

  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
