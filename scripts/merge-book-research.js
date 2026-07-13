// One-off: merges the 9 award/bestseller research lists + 2 canon-research
// lists (see CLAUDE.md session history / scratchpad) into a single deduped
// CSV for scripts/bulk-import.js. Read-only against the DB (just checks
// what's already present) — no writes here.
//
// Dedup key: normalized title + normalized author last name. A book on
// multiple source lists keeps ALL of its tags (union), and its genre comes
// from the first source with a *confident* genre signal — NYT bestsellers
// mix Fiction/Nonfiction with no per-entry marker, so NYT-only entries are
// deliberately left genre-blank (bulk-import.js falls back to Google Books'
// own genre for blank rows — imperfect, but better than forcing "Fiction"
// onto what might be a memoir).
require('dotenv').config();
const fs = require('fs');
const prisma = require('../src/lib/prisma');

const SCRATCH = 'C:/Users/jalex/AppData/Local/Temp/claude/C--Users-jalex-Documents-GitHub-isitstillgood/e2623e02-e5ec-4ff2-8687-a0781bd04abe/scratchpad';

const SOURCES = [
  { file: 'pulitzer_nba_final.txt', tag: 'Pulitzer/National Book Award', genre: 'Fiction' },
  { file: 'booker_final.txt', tag: 'Booker Prize', genre: 'Fiction' },
  { file: 'intl_booker_final.txt', tag: 'International Booker Prize', genre: 'Fiction' },
  { file: 'hugo_final.txt', tag: 'Hugo Award', genre: 'Science Fiction;Fantasy' },
  { file: 'nebula_parsed.txt', tag: 'Nebula Award', genre: 'Science Fiction;Fantasy' },
  { file: 'newbery_final.txt', tag: 'Newbery Medal', genre: 'Juvenile Fiction' },
  { file: 'caldecott_final.txt', tag: 'Caldecott Medal', genre: 'Juvenile Fiction' },
  { file: 'goodreads_final.txt', tag: 'Goodreads Choice Award', genre: 'Fiction' },
  { file: 'nyt_combined_sorted.txt', tag: 'NYT Bestseller', genre: '' },
  { file: 'banned_parsed_clean.txt', tag: 'Frequently Challenged Book', genre: 'Fiction' },
  { file: 'entries_only.txt', tag: 'African American Literature', genre: 'Fiction' },
  { file: 'multicultural_final.txt', tag: 'Multicultural Literature', genre: 'Fiction' },
  // "Epic" genre matches the existing DB convention (confirmed against the
  // already-present Wheel of Time entries — they're tagged Fiction/Fantasy/
  // Epic, not Science Fiction), not the Hugo/Nebula default above.
  { file: 'fantasy_authors_final.txt', tag: 'Commercially Successful Fantasy', genre: 'Fiction;Fantasy;Epic' },
];

function normTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/[.,:;!?'"]/g, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
}
function normAuthor(a) {
  if (!a) return '';
  // First named author's last word (handles "and"/"," separated multi-author strings reasonably)
  const first = a.split(/,| and | & /i)[0].trim();
  const words = first.replace(/[.'"]/g, '').split(/\s+/);
  return (words[words.length - 1] || '').toLowerCase();
}
function parseYear(y) {
  if (!y) return null;
  const m = String(y).match(/\d{4}/);
  return m ? parseInt(m[0]) : null;
}

// Some Hugo/Nebula "Best Novel" entries are actually a whole series
// nominated as one unit (e.g. the 2014 Hugo went to "The Wheel of Time" as
// a single entry, covering all 14 books) rather than an individual novel.
// Importing that literally would create one nonsense "book" — instead we
// drop the literal series-title line (see SKIP_LINES below) and expand it
// into its real constituent novels here, tagged/genred the same as if each
// had been nominated individually, and linked via seriesName/seriesNumber
// (the site's existing book-series convention — see CLAUDE.md).
const SKIP_LINES = new Set([
  normTitle('The Wheel of Time') + '|' + normAuthor('Robert Jordan and Brandon Sanderson'),
]);

const SERIES_EXPANSIONS = [
  {
    seriesName: 'The Wheel of Time',
    tag: 'Hugo Award',
    genre: 'Science Fiction;Fantasy',
    books: [
      { title: 'The Eye of the World', year: 1990, num: 1, author: 'Robert Jordan' },
      { title: 'The Great Hunt', year: 1990, num: 2, author: 'Robert Jordan' },
      { title: 'The Dragon Reborn', year: 1991, num: 3, author: 'Robert Jordan' },
      { title: 'The Shadow Rising', year: 1992, num: 4, author: 'Robert Jordan' },
      { title: 'The Fires of Heaven', year: 1993, num: 5, author: 'Robert Jordan' },
      { title: 'Lord of Chaos', year: 1994, num: 6, author: 'Robert Jordan' },
      { title: 'A Crown of Swords', year: 1996, num: 7, author: 'Robert Jordan' },
      { title: 'The Path of Daggers', year: 1998, num: 8, author: 'Robert Jordan' },
      { title: "Winter's Heart", year: 2000, num: 9, author: 'Robert Jordan' },
      { title: 'Crossroads of Twilight', year: 2003, num: 10, author: 'Robert Jordan' },
      { title: 'Knife of Dreams', year: 2005, num: 11, author: 'Robert Jordan' },
      { title: 'The Gathering Storm', year: 2009, num: 12, author: 'Robert Jordan and Brandon Sanderson' },
      { title: 'Towers of Midnight', year: 2010, num: 13, author: 'Robert Jordan and Brandon Sanderson' },
      { title: 'A Memory of Light', year: 2013, num: 14, author: 'Robert Jordan and Brandon Sanderson' },
    ],
  },
];

async function main() {
  const merged = new Map(); // key -> { title, author, year, tags:Set, genre, seriesName, seriesNumber }

  for (const src of SOURCES) {
    const path = `${SCRATCH}/${src.file}`;
    if (!fs.existsSync(path)) { console.log(`(missing, skipping) ${src.file}`); continue; }
    const lines = fs.readFileSync(path, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    let count = 0;
    for (const line of lines) {
      const parts = line.split('|').map(s => s.trim());
      if (parts.length < 2) continue;
      const [title, author, yearRaw] = parts;
      if (!title || !author) continue;
      const key = `${normTitle(title)}|${normAuthor(author)}`;
      if (!key.trim() || key === '|') continue;
      if (SKIP_LINES.has(key)) { console.log(`  (skipping series-as-single-entry line: "${title}")`); continue; }
      const year = parseYear(yearRaw);

      if (merged.has(key)) {
        const existing = merged.get(key);
        existing.tags.add(src.tag);
        if (!existing.genre && src.genre) existing.genre = src.genre;
        if (!existing.year && year) existing.year = year;
      } else {
        merged.set(key, { title, author, year, tags: new Set([src.tag]), genre: src.genre || '', seriesName: '', seriesNumber: '' });
      }
      count++;
    }
    console.log(`${src.file}: ${count} lines parsed`);
  }

  for (const expansion of SERIES_EXPANSIONS) {
    for (const book of expansion.books) {
      const key = `${normTitle(book.title)}|${normAuthor(book.author)}`;
      if (merged.has(key)) {
        const existing = merged.get(key);
        existing.tags.add(expansion.tag);
        if (!existing.genre) existing.genre = expansion.genre;
        existing.seriesName = expansion.seriesName;
        existing.seriesNumber = book.num;
      } else {
        merged.set(key, {
          title: book.title, author: book.author, year: book.year,
          tags: new Set([expansion.tag]), genre: expansion.genre,
          seriesName: expansion.seriesName, seriesNumber: book.num,
        });
      }
    }
    console.log(`Expanded "${expansion.seriesName}" into ${expansion.books.length} individual books`);
  }

  console.log(`\n${merged.size} unique books after cross-source dedup.\n`);

  // Cross-check against existing DB catalog
  console.log('Loading existing books from DB...');
  const existing = await prisma.mediaItem.findMany({ where: { mediaType: 'BOOK' }, select: { title: true, authors: { select: { name: true } } } });
  const existingKeys = new Set();
  for (const e of existing) {
    const authorName = e.authors[0]?.name || '';
    existingKeys.add(`${normTitle(e.title)}|${normAuthor(authorName)}`);
    existingKeys.add(normTitle(e.title)); // title-only fallback too, in case author format differs
  }
  console.log(`${existing.length} existing books loaded.\n`);

  const finalRows = [];
  let skippedExisting = 0;
  for (const [key, book] of merged) {
    if (existingKeys.has(key) || existingKeys.has(normTitle(book.title))) {
      skippedExisting++;
      continue;
    }
    finalRows.push(book);
  }

  console.log(`Already in DB (skipped): ${skippedExisting}`);
  console.log(`Final new candidates: ${finalRows.length}\n`);

  // Write CSV for bulk-import.js: mediaType,title,year,author,seriesName,seriesNumber,tags,genres
  const csvLines = ['mediaType,title,year,author,seriesName,seriesNumber,tags,genres'];
  for (const b of finalRows) {
    const esc = s => `"${String(s || '').replace(/"/g, '""')}"`;
    csvLines.push([
      'BOOK',
      esc(b.title),
      b.year || '',
      esc(b.author),
      esc(b.seriesName || ''),
      b.seriesNumber || '',
      esc([...b.tags].join(';')),
      esc(b.genre),
    ].join(','));
  }
  fs.writeFileSync(`${SCRATCH}/book-backfill-final.csv`, csvLines.join('\n') + '\n');
  console.log(`Written ${finalRows.length} rows to book-backfill-final.csv`);

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
