/**
 * Put books that are already in the catalogue into the series they belong
 * to.
 *
 *   node scripts/backfill-series.js                      # report all
 *   node scripts/backfill-series.js --only=Discworld
 *   node scripts/backfill-series.js --apply
 *
 * Imports set seriesName from the CSV, so this is only ever needed for
 * books added before the series was known — which is most of them. The
 * eleven Pratchett books here predated the Discworld import and all had
 * seriesName null.
 *
 * It matters more than it looks. A book series has no parent row: the books
 * share a seriesName string and the lowest-numbered one acts as the series
 * page, aggregating ratings across the whole series (see "Data model" in
 * CLAUDE.md). So an unnumbered book is not a cosmetic gap — it is a book
 * missing from that page's aggregate, and if the unnumbered one is book
 * one, the series starts at book two.
 *
 * Numbered by publication order, which is what these series' numbering
 * conventionally means, and matched on exact title against a fixed list
 * rather than anything inferred. The whole point is not to guess: every
 * number below is one specific novel. Omnibus editions ("The Foundation
 * Trilogy", "The Complete Sherlock Holmes") are deliberately absent, so
 * they are left out of the series rather than given a number inside it.
 *
 * To extend: add a series, with its author as the catalogue spells it so
 * two authors' same-named series cannot collide.
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyArg = args.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).toLowerCase() : null;

const SERIES = [
  {
    name: 'Discworld', author: 'Terry Pratchett',
    books: ['The Colour of Magic', 'The Light Fantastic', 'Equal Rites', 'Mort',
      'Sourcery', 'Wyrd Sisters', 'Pyramids', 'Guards! Guards!', 'Eric',
      'Moving Pictures', 'Reaper Man', 'Witches Abroad', 'Small Gods',
      'Lords and Ladies', 'Men at Arms', 'Soul Music', 'Interesting Times',
      'Maskerade', 'Feet of Clay', 'Hogfather', 'Jingo', 'The Last Continent',
      'Carpe Jugulum', 'The Fifth Elephant', 'The Truth', 'Thief of Time',
      'The Last Hero', 'The Amazing Maurice and His Educated Rodents',
      'Night Watch', 'The Wee Free Men', 'Monstrous Regiment',
      'A Hat Full of Sky', 'Going Postal', 'Thud!', 'Wintersmith',
      'Making Money', 'Unseen Academicals', 'I Shall Wear Midnight', 'Snuff',
      'Raising Steam', "The Shepherd's Crown"],
  },
  {
    name: 'Foundation', author: 'Isaac Asimov',
    books: ['Foundation', 'Foundation and Empire', 'Second Foundation',
      "Foundation's Edge", 'Foundation and Earth', 'Prelude to Foundation',
      'Forward the Foundation'],
  },
  {
    name: 'Robot', author: 'Isaac Asimov',
    books: ['I, Robot', 'The Caves of Steel', 'The Naked Sun',
      'The Robots of Dawn', 'Robots and Empire'],
  },
  {
    name: 'Galactic Empire', author: 'Isaac Asimov',
    books: ['Pebble in the Sky', 'The Stars, Like Dust', 'The Currents of Space'],
  },
];

(async () => {
  let totalTodo = 0;
  const work = [];

  for (const series of SERIES) {
    if (ONLY && !series.name.toLowerCase().includes(ONLY)) continue;
    const author = await prisma.person.findFirst({
      where: { name: series.author }, select: { id: true },
    });
    if (!author) { console.log(`${series.name}: no "${series.author}" in the catalogue\n`); continue; }

    const have = await prisma.mediaItem.findMany({
      where: { mediaType: 'BOOK', authors: { some: { id: author.id } } },
      select: { id: true, title: true, seriesName: true, seriesNumber: true },
    });
    const byTitle = new Map(have.map(b => [b.title.trim(), b]));

    const todo = [], missing = [];
    series.books.forEach((title, i) => {
      const n = i + 1;
      const book = byTitle.get(title);
      if (!book) { missing.push(`#${n} ${title}`); return; }
      if (book.seriesName !== series.name || book.seriesNumber !== n) {
        todo.push({ ...book, n, series: series.name });
      }
    });

    console.log(`── ${series.name} (${series.author}) ─────────────────────`);
    console.log(`   ${series.books.length - missing.length}/${series.books.length} in the catalogue, `
      + `${todo.length} needing the series set`);
    todo.forEach(b => console.log(`   + #${String(b.n).padStart(2)} ${b.title}`
      + (b.seriesName ? `  (currently ${b.seriesName} #${b.seriesNumber})` : '')));
    if (missing.length) console.log(`   not in the catalogue: ${missing.join(', ')}`);
    console.log('');

    totalTodo += todo.length;
    work.push(...todo);
  }

  if (!APPLY) { console.log(`Dry run. ${totalTodo} book(s) would be updated — re-run with --apply.`); }
  else {
    for (const b of work) {
      await prisma.mediaItem.update({
        where: { id: b.id }, data: { seriesName: b.series, seriesNumber: b.n },
      });
    }
    console.log(`Set the series on ${work.length} book(s).`);
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
