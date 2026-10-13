/**
 * Build a bulk-import CSV of everything an author wrote that the catalogue
 * is missing.
 *
 *   node scripts/author-bibliography.js "Dean Koontz"
 *   node scripts/author-bibliography.js "Terry Pratchett" --out scripts/pratchett.csv
 *   node scripts/author-bibliography.js "Isaac Asimov" --max-pages 6
 *
 * Why this exists: book coverage is lopsided. Stephen King had 93 titles and
 * Dean Koontz 7, against a hundred-odd novels each. sync-new-books.js only
 * ever pulls the current NYT bestseller lists, so it can add this week's
 * releases and will never fill in a back catalogue.
 *
 * It only writes a CSV. Feed that to bulk-import.js, which is still the one
 * path into the database and still gets its dry run first:
 *
 *   node scripts/bulk-import.js scripts/koontz.csv --dry-run
 *
 * Google Books' author search returns a great deal that is not a novel —
 * study guides, box sets, foreign editions, "A Summary of" cash-ins — so
 * most of the work here is throwing things away. It errs toward dropping a
 * real book over admitting a fake one, because a wrong row costs a manual
 * cleanup and a missing row costs another run of this script.
 */
require('dotenv').config();
const fs = require('fs');
const prisma = require('../src/lib/prisma');
const { normalizeTitleForSearch } = require('../src/lib/mediaHelpers');

const args = process.argv.slice(2);
const AUTHOR = args.find(a => !a.startsWith('--'));
const outFlag = args.indexOf('--out');
const OUT = outFlag > -1 ? args[outFlag + 1] : null;
const pagesFlag = args.indexOf('--max-pages');
const MAX_PAGES = pagesFlag > -1 ? Number(args[pagesFlag + 1]) : 8;
const PER_PAGE = 40;                       // Google Books' maximum

if (!AUTHOR) {
  console.error('Usage: node scripts/author-bibliography.js "Author Name" [--out file.csv] [--max-pages N]');
  process.exit(1);
}

// Not a novel by this author, whatever Google Books says it is.
const JUNK = [
  /\b(study guide|sparknotes|cliffsnotes|shmoop|quicklet)\b/i,
  /\b(summary|analysis|review|companion|workbook|guide) (of|to|for)\b/i,
  /\bconversation starters\b/i,
  /\b(boxed|box) set\b/i,
  /\b(omnibus|collection|anthology|series set|\d+ books?)\b/i,
  /\bcomplete (works|series|novels)\b/i,
  /\blarge print\b/i,
  /\b(unabridged|abridged)\b/i,
  /^a? ?novel by\b/i,
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* Google Books hands out 503s and 429s freely on a run of this length —
   the first attempt at a full bibliography died on a 503 at the very first
   page. mediaLookup has a retry helper but does not export it, and reaching
   into it from a script would couple this to its internals, so this keeps
   its own with the same backoff shape. */
async function fetchWithRetry(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      // 4xx other than rate limiting will not improve by asking again.
      if (res.status < 500 && res.status !== 429) return res;
      if (i === attempts - 1) return res;
    } catch (e) {
      if (i === attempts - 1) throw e;
    }
    await sleep(900 * Math.pow(2, i));
  }
}

async function fetchPage(startIndex) {
  const q = `inauthor:"${AUTHOR}"`;
  const url = 'https://www.googleapis.com/books/v1/volumes'
    + `?q=${encodeURIComponent(q)}`
    + `&startIndex=${startIndex}&maxResults=${PER_PAGE}`
    + '&printType=books&orderBy=newest&langRestrict=en'
    + `&key=${process.env.GOOGLE_BOOKS_API_KEY}`;
  const res = await fetchWithRetry(url);
  if (!res || !res.ok) {
    console.error(`  Google Books returned ${res ? res.status : 'no response'} at startIndex ${startIndex}`);
    return [];
  }
  return (await res.json()).items || [];
}

(async () => {
  if (!process.env.GOOGLE_BOOKS_API_KEY) {
    console.error('GOOGLE_BOOKS_API_KEY is not set'); process.exit(1);
  }
  console.log(`Searching Google Books for "${AUTHOR}"…\n`);

  const seen = new Map();      // normalised title -> row
  let raw = 0, dropped = { junk: 0, wrongAuthor: 0, noYear: 0, dupe: 0 };

  for (let p = 0; p < MAX_PAGES; p++) {
    const items = await fetchPage(p * PER_PAGE);
    if (!items.length) break;
    for (const it of items) {
      raw++;
      const info = it.volumeInfo || {};
      const title = String(info.title || '').trim();
      if (!title) continue;

      // Google's inauthor is fuzzy and will hand back books this person
      // merely contributed a foreword to, or someone of a similar name.
      const authors = (info.authors || []).map(a => a.toLowerCase());
      if (!authors.includes(AUTHOR.toLowerCase())) { dropped.wrongAuthor++; continue; }

      const full = info.subtitle ? `${title}: ${info.subtitle}` : title;
      if (JUNK.some(re => re.test(full))) { dropped.junk++; continue; }

      // No year means no sensible row — bulk-import ranks candidates on it.
      const year = parseInt(String(info.publishedDate || '').slice(0, 4), 10);
      if (!year || year < 1850 || year > new Date().getFullYear() + 1) { dropped.noYear++; continue; }

      const key = normalizeTitleForSearch(title);
      const prev = seen.get(key);
      // Same work, several editions: keep the earliest year, which is the
      // closest thing Google Books offers to a first publication date.
      if (prev) { dropped.dupe++; if (year < prev.year) prev.year = year; continue; }
      seen.set(key, { title, year });
    }
    await sleep(400);
  }

  console.log(`  ${raw} volumes returned`);
  console.log(`  dropped: ${dropped.wrongAuthor} not by them, ${dropped.junk} not novels, `
    + `${dropped.noYear} undated, ${dropped.dupe} duplicate editions`);

  // What the catalogue already has for this author, by title, so a second
  // run of this script produces nothing rather than a pile of duplicates.
  const person = await prisma.person.findFirst({
    where: { name: AUTHOR },
    select: { authored: { select: { title: true, normalizedTitle: true } } },
  });
  const have = new Set((person?.authored || [])
    .map(b => b.normalizedTitle || normalizeTitleForSearch(b.title)));
  console.log(`  catalogue already has ${have.size} by this author`);

  const rows = [...seen.values()]
    .filter(r => !have.has(normalizeTitleForSearch(r.title)))
    .sort((a, b) => a.year - b.year);

  if (!rows.length) { console.log('\nNothing missing.'); await prisma.$disconnect(); return; }

  const csv = ['mediaType,title,year,author,seriesName,seriesNumber,tags,genres']
    .concat(rows.map(r => ['BOOK', csvCell(r.title), r.year, csvCell(AUTHOR), '', '', '', ''].join(',')))
    .join('\n') + '\n';

  const out = OUT || `scripts/${AUTHOR.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-import.csv`;
  fs.writeFileSync(out, csv);
  console.log(`\n${rows.length} missing title(s) written to ${out}`);
  console.log(`Earliest ${rows[0].year}, latest ${rows[rows.length - 1].year}`);
  console.log(`\nReview it, then:\n  node scripts/bulk-import.js ${out} --dry-run`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
