// scripts/backfill-cast-order.js
//
// Populates MediaItem.castOrder for rows imported before that column existed.
//
// castOrder holds cast Person ids in TMDB billing order; sortByCastOrder()
// falls back to an alphabetical sort when it's empty (see mediaHelpers), so
// every pre-existing movie and show currently lists its cast alphabetically
// instead of billed order — top billing buried under whoever's name starts
// with 'A'. connectCast() sets it for anything imported since, but ~30k older
// rows were never revisited.
//
//   node scripts/backfill-cast-order.js --dry-run [--limit=N]
//   node scripts/backfill-cast-order.js --confirm [--limit=N] [--type=MOVIE]
//
// Only ever writes castOrder. The cast relation itself is left exactly as it
// is: TMDB's credits change over time, and re-connecting cast here would
// silently add or drop people as a side effect of a sort fix. Anyone in the
// stored cast that TMDB no longer lists sorts to the end alphabetically,
// which is the same place they'd have been before.
//
// Resumable: it selects on castOrder being empty, so an interrupted run just
// picks up where it stopped.

require('dotenv').config();
const prisma = require('../src/lib/prisma');

const CONFIRM = process.argv.includes('--confirm');
const DRY = !CONFIRM;
const argOf = (n, d) => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const LIMIT = parseInt(argOf('limit', '0'), 10) || Infinity;
const TYPE = argOf('type', null);

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tmdb(path) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://api.themoviedb.org/3${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    });
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep(2000); continue; }
    return null; // 404 etc — nothing to order by
  }
  return null;
}

// Season rows carry their show's tmdbId, but older ones may have none at all;
// fall back to the parent row in that case.
async function creditsPathFor(item) {
  if (item.mediaType === 'MOVIE') {
    return item.tmdbId ? `/movie/${item.tmdbId}/credits?language=en-US` : null;
  }
  if (item.parentId) {
    let showId = item.tmdbId;
    if (!showId) {
      const p = await prisma.mediaItem.findUnique({ where: { id: item.parentId }, select: { tmdbId: true } });
      showId = p?.tmdbId;
    }
    if (!showId || item.seasonNumber == null) return null;
    return `/tv/${showId}/season/${item.seasonNumber}/credits?language=en-US`;
  }
  return item.tmdbId ? `/tv/${item.tmdbId}/credits?language=en-US` : null;
}

async function main() {
  if (!TOKEN) throw new Error('TMDB_READ_ACCESS_TOKEN missing from .env');

  const where = {
    castOrder: { isEmpty: true },
    cast: { some: {} },
    ...(TYPE ? { mediaType: TYPE } : { mediaType: { in: ['MOVIE', 'TV_SHOW'] } }),
  };
  const total = await prisma.mediaItem.count({ where });
  console.log(`${total} item(s) with cast but no billing order${DRY ? ' (dry run — no writes)' : ''}\n`);

  let processed = 0, updated = 0, noCredits = 0, unchanged = 0;
  const BATCH = 200;

  // Page by id rather than re-running the `castOrder is empty` filter each
  // time. A skipped row stays empty, so a re-filtering loop hands back the
  // same rows on every pass and burns TMDB calls on them forever — the first
  // version of this did exactly that, reporting 16,200 "processed" while
  // grinding over a few hundred unfixable rows.
  const ids = (await prisma.mediaItem.findMany({
    where, select: { id: true }, orderBy: { id: 'asc' },
  })).map(r => r.id).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`Queued ${ids.length} id(s) for one pass.\n`);

  for (let off = 0; off < ids.length; off += BATCH) {
    const batch = await prisma.mediaItem.findMany({
      where: { id: { in: ids.slice(off, off + BATCH) } },
      select: {
        id: true, title: true, mediaType: true, tmdbId: true,
        parentId: true, seasonNumber: true,
        cast: { select: { id: true, name: true } },
      },
    });
    if (!batch.length) continue;

    for (const item of batch) {
      processed++;
      const path = await creditsPathFor(item);
      if (!path) { noCredits++; continue; }

      const credits = await tmdb(path);
      // `cast` only — series regulars, in billed order. Deliberately NOT
      // guest_stars: a season row whose stored cast is entirely guest stars
      // has no real billing order to recover, and ranking it by TMDB's
      // guest-star array produces something that looks authoritative but
      // frequently just reproduces the alphabetical order it replaced. Those
      // rows are left unordered rather than given a misleading one.
      const billed = (credits?.cast || []).map(c => (c.name || '').toLowerCase());
      if (!billed.length) { noCredits++; await sleep(80); continue; }

      const rank = new Map();
      billed.forEach((n, i) => { if (!rank.has(n)) rank.set(n, i); });

      const ordered = [...item.cast].sort((a, b) => {
        const ra = rank.has(a.name.toLowerCase()) ? rank.get(a.name.toLowerCase()) : Infinity;
        const rb = rank.has(b.name.toLowerCase()) ? rank.get(b.name.toLowerCase()) : Infinity;
        return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
      });

      // If nobody in the stored cast appears in TMDB's list, an "order" here
      // would just be the alphabetical fallback written to the column —
      // no gain, and it would stop a later run from retrying.
      const anyMatched = ordered.some(p => rank.has(p.name.toLowerCase()));
      if (!anyMatched) { unchanged++; await sleep(80); continue; }

      if (!DRY) {
        await prisma.mediaItem.update({
          where: { id: item.id },
          data: { castOrder: ordered.map(p => p.id) },
        });
      }
      updated++;
      if (updated <= 5 || updated % 500 === 0) {
        console.log(`  ${DRY ? '+' : '✓'} ${item.title} — top billed: ${ordered.slice(0, 3).map(p => p.name).join(', ')}`);
      }
      await sleep(80);
    }

    console.log(`  …${processed}/${ids.length} processed, ${updated} ordered, ${noCredits + unchanged} skipped`);
    if (DRY) break; // dry run: one batch is enough to prove the shape
  }

  console.log(`\nDone. ${DRY ? 'Would order' : 'Ordered'} ${updated}, no usable credits ${noCredits}, no name overlap ${unchanged}.`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
