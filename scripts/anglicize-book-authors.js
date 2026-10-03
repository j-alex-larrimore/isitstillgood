// Renames book authors stored in a non-Latin script to the English form.
//
//   node scripts/anglicize-book-authors.js --dry-run     (do this first)
//   node scripts/anglicize-book-authors.js
//
// Policy: this catalogue carries books written in English or the English
// translation of a book. A reader here looking for War and Peace wants Leo
// Tolstoy, not Лев Толстой — and their Goodreads or StoryGraph export will say
// so too, which is the practical half: a title+author fallback match can never
// fire against a Cyrillic author field.
//
// ─── Where the name comes from, and two sources that did not work ──────────
//
// Open Library author -> remote_ids.wikidata -> Wikidata labels.en.
//
// Wikidata's English label is exactly the question being asked — what do
// English speakers call this person — and it is curated, free and unmetered.
//
// Rejected, in order:
//
//   Open Library alternate_names. A dump of every variant any cataloguer ever
//   entered: the form an English publisher prints sits beside romanization
//   spellings ("Solzhenit͡s︡yn", "Dmitriĭ"), other languages ("Homère"),
//   abbreviations ("E. Oda"), ALL CAPS, duplicates ("Homer Homer") and plain
//   errors. Two different ranking heuristics both picked wrong names —
//   "Aleksandr Pavlovich Chekhov" for Anton Chekhov, "Kharuki Murakami" for
//   Haruki. The field is not rankable; the problem was the source.
//
//   Google Books by ISBN, filtered to language "en". Conceptually right — it
//   is the English edition's own credit — but Google does not index most of
//   these ISBNs (War and Peace has 409 and the sample returned zero items),
//   so it would have needed ~960 lookups against a ~1,000/day quota to maybe
//   resolve two dozen names.
//
// Merging, not just renaming: if a Person already exists under the English name
// the credits move onto that row and the non-Latin row is deleted. Renaming
// alone would leave two Tolstoys.
//
// Scope is deliberately books only. The same collapse left ~117 screen credits
// on foreign films and TV in their native scripts; whether a Korean actor in a
// Korean drama should be listed in Hangul is a different question from what an
// English edition prints on its cover, so this does not touch them.
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify } = require('../src/lib/mediaHelpers');

const UA = 'isitstillgood-anglicize/1.0 (j.alex.larrimore@gmail.com)';
const PACE_MS = 220;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DRY = process.argv.includes('--dry-run');

// Real writing systems, not Latin-with-diacritics. "Charlotte Brontë" and
// "The Rāmāyaṇa of Vālmīki" are English typography and stay exactly as they are.
const NONLATIN = /[Ѐ-ӿͰ-Ͽ֐-׿؀-ۿऀ-ॿ฀-๿ᄀ-ᇿ぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
const isLatin = s => s && !NONLATIN.test(s) && /[A-Za-z]/.test(s);

async function getJson(url){
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    await sleep(PACE_MS);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function englishNameFor(person, workIds){
  for (const workId of workIds.slice(0, 4)) {
    const work = await getJson(`https://openlibrary.org/works/${workId}.json`);
    for (const ref of (work?.authors || [])) {
      const key = ref.author?.key;
      if (!key) continue;
      const author = await getJson(`https://openlibrary.org${key}.json`);
      // Only accept a record that IS this person — on a co-authored book the
      // other author's record would otherwise rename them to their collaborator.
      if (author?.name !== person.name) continue;
      const qid = author?.remote_ids?.wikidata;
      if (!qid) continue;
      const wd = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
      const label = wd?.entities?.[qid]?.labels?.en?.value;
      if (isLatin(label)) return label.trim();
    }
  }
  return null;
}

(async () => {
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK' },
    select: { id: true, title: true, goodreadsId: true, authors: { select: { id: true, name: true } } },
  });

  const targets = new Map();
  for (const b of books) {
    for (const a of b.authors) {
      if (!NONLATIN.test(a.name)) continue;
      if (!targets.has(a.id)) targets.set(a.id, { person: a, works: [] });
      if (/^OL\d+W$/.test(b.goodreadsId || '')) targets.get(a.id).works.push(b.goodreadsId);
    }
  }

  console.log(`${targets.size} book authors stored in a non-Latin script${DRY ? '   [DRY RUN]' : ''}\n`);

  let renamed = 0, merged = 0, unresolved = 0;

  for (const { person, works } of targets.values()) {
    const english = await englishNameFor(person, works);

    if (!english) {
      unresolved++;
      console.log(`   ? ${person.name.padEnd(28)} no Wikidata English label — left as is`);
      continue;
    }

    const existing = await prisma.person.findUnique({ where: { slug: slugify(english) }, select: { id: true, name: true } });

    if (existing && existing.id !== person.id) {
      console.log(`   ⇒ ${person.name.padEnd(28)} merge into existing "${existing.name}"`);
      merged++;
      if (DRY) continue;
      for (const field of ['authors', 'cast', 'directors']) {
        const items = await prisma.mediaItem.findMany({
          where: { [field]: { some: { id: person.id } } },
          select: { id: true, castOrder: true },
        });
        for (const it of items) {
          // connect is a no-op when the target is already attached, so a book
          // crediting both forms merges rather than erroring.
          await prisma.mediaItem.update({
            where: { id: it.id },
            data: { [field]: { disconnect: { id: person.id }, connect: { id: existing.id } } },
          });
          if (field === 'cast' && it.castOrder?.includes(person.id)) {
            await prisma.mediaItem.update({
              where: { id: it.id },
              data: { castOrder: [...new Set(it.castOrder.map(x => x === person.id ? existing.id : x))] },
            });
          }
        }
      }
      await prisma.person.delete({ where: { id: person.id } });
    } else {
      console.log(`   ✓ ${person.name.padEnd(28)} → ${english}`);
      renamed++;
      if (DRY) continue;
      // The slug moves with the name so a future import of "Leo Tolstoy" lands
      // on this row instead of creating a second one.
      await prisma.person.update({ where: { id: person.id }, data: { name: english, slug: slugify(english) } });
    }
  }

  console.log(`\nrenamed ${renamed} · merged into an existing English row ${merged} · unresolved ${unresolved}`);
  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
