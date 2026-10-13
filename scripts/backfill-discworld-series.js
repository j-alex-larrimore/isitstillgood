/**
 * Put the Discworld books already in the catalogue into the Discworld
 * series.
 *
 *   node scripts/backfill-discworld-series.js [--apply]
 *
 * The eleven Pratchett books imported before this all have seriesName null,
 * so they sit as unrelated standalones while the thirty imported alongside
 * this carry their numbers. A book series has no parent row — the books
 * share a seriesName string and the lowest-numbered one acts as the series
 * page (see "Data model" in CLAUDE.md) — so one unnumbered book is not a
 * cosmetic gap: it is a book missing from the series page's aggregate, and
 * if the unnumbered one happens to be The Colour of Magic then the series
 * page starts at book two.
 *
 * Matched on exact title against a fixed list rather than anything clever.
 * The whole point is to not guess: Discworld's numbering is publication
 * order and every number here is one specific novel.
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const APPLY = process.argv.includes('--apply');

// Publication order, which is what Discworld numbering means.
const DISCWORLD = {
  'The Colour of Magic': 1, 'The Light Fantastic': 2, 'Equal Rites': 3,
  'Mort': 4, 'Sourcery': 5, 'Wyrd Sisters': 6, 'Pyramids': 7,
  'Guards! Guards!': 8, 'Eric': 9, 'Moving Pictures': 10, 'Reaper Man': 11,
  'Witches Abroad': 12, 'Small Gods': 13, 'Lords and Ladies': 14,
  'Men at Arms': 15, 'Soul Music': 16, 'Interesting Times': 17,
  'Maskerade': 18, 'Feet of Clay': 19, 'Hogfather': 20, 'Jingo': 21,
  'The Last Continent': 22, 'Carpe Jugulum': 23, 'The Fifth Elephant': 24,
  'The Truth': 25, 'Thief of Time': 26, 'The Last Hero': 27,
  'The Amazing Maurice and His Educated Rodents': 28, 'Night Watch': 29,
  'The Wee Free Men': 30, 'Monstrous Regiment': 31, 'A Hat Full of Sky': 32,
  'Going Postal': 33, 'Thud!': 34, 'Wintersmith': 35, 'Making Money': 36,
  'Unseen Academicals': 37, 'I Shall Wear Midnight': 38, 'Snuff': 39,
  'Raising Steam': 40, "The Shepherd's Crown": 41,
};

(async () => {
  const author = await prisma.person.findFirst({
    where: { name: 'Terry Pratchett' }, select: { id: true },
  });
  if (!author) { console.error('No Terry Pratchett in the catalogue.'); process.exit(1); }

  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', authors: { some: { id: author.id } } },
    select: { id: true, title: true, seriesName: true, seriesNumber: true },
  });

  const todo = books
    .map(b => ({ ...b, n: DISCWORLD[b.title.trim()] }))
    .filter(b => b.n && (b.seriesName !== 'Discworld' || b.seriesNumber !== b.n));

  console.log(`${books.length} Pratchett books, ${todo.length} needing the series set\n`);
  todo.sort((a, b) => a.n - b.n).forEach(b =>
    console.log(`  #${String(b.n).padStart(2)}  ${b.title}`
      + (b.seriesName ? `  (currently ${b.seriesName} #${b.seriesNumber})` : '')));

  const missing = Object.keys(DISCWORLD)
    .filter(t => !books.some(b => b.title.trim() === t));
  if (missing.length) console.log(`\nStill not in the catalogue (${missing.length}): ${missing.join(', ')}`);

  if (!APPLY) { console.log('\nDry run — re-run with --apply.'); await prisma.$disconnect(); return; }

  for (const b of todo) {
    await prisma.mediaItem.update({
      where: { id: b.id }, data: { seriesName: 'Discworld', seriesNumber: b.n },
    });
  }
  console.log(`\nSet the series on ${todo.length} book(s).`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
