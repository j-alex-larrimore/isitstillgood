// scripts/backfill-nyt-bestsellers.js
//
// Backfills the catalog with historical NYT bestsellers. sync-new-books.js
// only ever looks at the CURRENT week's lists, so everything that charted
// before this site existed was never picked up — a sweep of 2012-2026 found
// 6,109 bestselling titles missing.
//
//   node scripts/backfill-nyt-bestsellers.js --dry-run
//   node scripts/backfill-nyt-bestsellers.js --confirm [--min-weeks=2] [--limit=N]
//
// Two phases:
//   1. Sweep NYT /lists/overview.json for one week per quarter. The overview
//      endpoint returns EVERY list for a date in a single call, which matters
//      because the NYT free tier allows only ~5 requests/minute. Results are
//      cached to .nyt-sweep-cache.json so phase 2 can be re-run without
//      paying for the sweep again.
//   2. For each candidate, look up the exact ISBN-13 NYT supplies against
//      Google Books. This is the whole point of the script: fuzzy
//      title/author search returns wrong editions and study guides (a 86-book
//      sample produced "Atomic Habits (Tamil)", "Dune (Movie Tie-In)", and a
//      Good Omens *study guide*), and slugs are permanent once written. An
//      ISBN-exact lookup has no such ambiguity.
//
// --min-weeks filters by how many sampled weeks a title charted for.
// Appearing once is often a one-week debut; 2+ is a durability signal.
//
// Genres come from which NYT list a book charted on, never Google Books'
// own category field — same deliberate choice sync-new-books.js documents.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, normalizeBookGenres, bookTitlesMatch } = require('../src/lib/mediaHelpers');
// ISBN lookup is local to this script (see lookupByIsbn) so a quota
// rejection can be told apart from a genuine miss.

const CONFIRM = process.argv.includes('--confirm');
const DRY = !CONFIRM;
const argOf = (name, dflt) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1], 10) : dflt;
};
const MIN_WEEKS = argOf('min-weeks', 2);
const LIMIT = argOf('limit', Infinity);
const FROM = argOf('from', 2012);
const TO = argOf('to', 2026);

const CACHE = path.join(__dirname, '..', '.nyt-sweep-cache.json');
const KEY = process.env.NYT_API_KEY;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Same mapping sync-new-books.js uses, keyed by NYT's list_name_encoded.
// Lists not named here still contribute their titles; they just fall back to
// a generic genre rather than being dropped.
const LIST_GENRE_MAP = {
  'hardcover-fiction': ['Fiction'],
  'trade-fiction-paperback': ['Fiction'],
  'paperback-trade-fiction': ['Fiction'],
  'combined-print-and-e-book-fiction': ['Fiction'],
  'e-book-fiction': ['Fiction'],
  'hardcover-nonfiction': ['Nonfiction'],
  'paperback-nonfiction': ['Nonfiction'],
  'combined-print-and-e-book-nonfiction': ['Nonfiction'],
  'e-book-nonfiction': ['Nonfiction'],
  'advice-how-to-and-miscellaneous': ['Self-Help'],
  'young-adult-hardcover': ['Young Adult', 'Fiction'],
  'young-adult-paperback-monthly': ['Young Adult', 'Fiction'],
  'series-books': ['Fiction'],
  'childrens-middle-grade-hardcover': ['Juvenile Fiction'],
  'picture-books': ['Juvenile Fiction'],
  'graphic-books-and-manga': ['Graphic Novels'],
  'business-books': ['Business'],
  'science': ['Science'],
  'sports': ['Sports'],
  'food-and-fitness': ['Nonfiction'],
};

// ─── ISBN lookup with a quota-aware fallback ───────────────────────────────
//
// mediaLookup's searchGoogleBooksByIsbn() returns null for ANY non-ok
// response, so a 429 "quota exceeded" is indistinguishable from "this ISBN
// isn't in Google Books". That silence is expensive here: a first run of this
// backfill reported 2,747 books as having "no ISBN match" when every one of
// them was actually a quota rejection — the daily Books API limit is far
// below what a sweep this size needs.
//
// So: call Google Books directly to see the real status, latch a flag the
// moment quota is hit (no point retrying 2,000 more times), and fall back to
// Open Library, which needs no key and has no comparable daily cap. Open
// Library splits its data across the edition (/isbn) and the work
// (/works/<key>), hence the second call for description.
let gbQuotaExhausted = false;
let gbCalls = 0, olCalls = 0;

async function lookupByIsbn(isbn) {
  if (!gbQuotaExhausted) {
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`isbn:${isbn}`)}&key=${process.env.GOOGLE_BOOKS_API_KEY}`);
      gbCalls++;
      if (r.status === 429) {
        gbQuotaExhausted = true;
        console.log('\n⚠ Google Books daily quota exhausted — falling back to Open Library for the rest of this run.\n');
      } else if (r.ok) {
        const item = ((await r.json()).items || [])[0];
        if (item) {
          const v = item.volumeInfo || {};
          const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null;
          return {
            source: 'google',
            title: v.title,
            releaseYear: v.publishedDate ? parseInt(v.publishedDate.slice(0, 4)) : null,
            description: v.description || null,
            imageUrl: img ? img.replace(/^http:/, 'https:') : null,
          };
        }
        return null; // genuinely absent from Google Books
      }
    } catch { /* fall through to Open Library */ }
  }

  // Open Library fallback
  try {
    const er = await fetch(`https://openlibrary.org/isbn/${isbn}.json`);
    olCalls++;
    if (!er.ok) return null;
    const ed = await er.json();
    let description = null;
    let coverId = (ed.covers || [])[0] || null;
    const workKey = ed.works?.[0]?.key;
    if (workKey) {
      await sleep(250);
      const wr = await fetch(`https://openlibrary.org${workKey}.json`);
      olCalls++;
      if (wr.ok) {
        const w = await wr.json();
        description = typeof w.description === 'string' ? w.description : (w.description?.value || null);
        if (!coverId) coverId = (w.covers || [])[0] || null;
      }
    }
    const year = ed.publish_date ? parseInt(String(ed.publish_date).match(/\d{4}/)?.[0] || '') : null;
    return {
      source: 'openlibrary',
      title: ed.title,
      releaseYear: Number.isFinite(year) ? year : null,
      description,
      imageUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
    };
  } catch { return null; }
}

function sampleDates(fromYear, toYear) {
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (const md of ['-02-15', '-05-15', '-08-15', '-11-15']) out.push(`${y}${md}`);
  }
  return out;
}

async function sweep() {
  if (fs.existsSync(CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    console.log(`Using cached NYT sweep: ${cached.length} candidate(s) from ${CACHE}`);
    return cached;
  }
  if (!KEY) throw new Error('NYT_API_KEY missing from .env');

  const byIsbn = new Map(); // isbn13 -> { isbn13, title, author, genres, weeks }
  const dates = sampleDates(FROM, TO);
  console.log(`Sweeping ${dates.length} NYT weeks (${FROM}-${TO}) — ~13s each for the rate limit…`);

  for (const d of dates) {
    let data;
    try {
      const r = await fetch(`https://api.nytimes.com/svc/books/v3/lists/overview.json?published_date=${d}&api-key=${KEY}`);
      if (!r.ok) { console.log(`  ${d}: HTTP ${r.status}`); await sleep(13000); continue; }
      data = await r.json();
    } catch (err) { console.log(`  ${d}: ${err.message}`); await sleep(13000); continue; }

    for (const list of data?.results?.lists || []) {
      const genres = LIST_GENRE_MAP[list.list_name_encoded] || ['Fiction'];
      for (const b of list.books || []) {
        const isbn = b.primary_isbn13;
        if (!isbn || !b.title) continue;
        const prev = byIsbn.get(isbn);
        if (prev) { prev.weeks++; continue; }
        byIsbn.set(isbn, { isbn13: isbn, title: b.title, author: b.author || '', genres, weeks: 1 });
      }
    }
    console.log(`  ${d}: ${byIsbn.size} distinct ISBNs so far`);
    await sleep(13000);
  }

  const out = [...byIsbn.values()];
  fs.writeFileSync(CACHE, JSON.stringify(out, null, 1));
  console.log(`\nSweep complete: ${out.length} distinct ISBNs cached to ${CACHE}`);
  return out;
}

// Duplicate detection, done in memory.
//
// mediaHelpers' findDuplicate() issues two case-insensitive queries per book.
// `mode: 'insensitive'` can't use a B-tree index, so each one is a sequential
// scan of the whole MediaItem table (66k rows) across the network — fine for
// the handful of rows the admin form adds, ruinous at thousands. The first
// attempt at this backfill managed ~2.7 books/minute and kept losing its
// Postgres connection mid-scan.
//
// Every book in the catalog fits comfortably in memory, so load them once and
// match locally using the same bookTitlesMatch() semantics findDuplicate uses
// for the BOOK branch: an exact title+author match is the same work in a
// different edition, with no year constraint (Google Books' year data for
// indie titles is unreliable — see the comment on findDuplicate).
async function loadExistingBooks() {
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK' },
    select: { id: true, title: true, slug: true, authors: { select: { name: true } } },
  });
  const byAuthor = new Map(); // lowercased author name -> [book]
  for (const b of books) {
    for (const a of b.authors) {
      const k = a.name.toLowerCase();
      if (!byAuthor.has(k)) byAuthor.set(k, []);
      byAuthor.get(k).push(b);
    }
  }
  return { books, byAuthor };
}

function findDuplicateLocal({ books, byAuthor }, title, author) {
  if (author) {
    for (const b of byAuthor.get(author.toLowerCase()) || []) {
      if (bookTitlesMatch(b.title, title)) return b;
    }
  }
  const t = title.trim().toLowerCase();
  return books.find(b => b.title.trim().toLowerCase() === t) || null;
}

async function main() {
  const all = await sweep();
  const candidates = all
    .filter(c => c.weeks >= MIN_WEEKS)
    .sort((a, b) => b.weeks - a.weeks)
    .slice(0, LIMIT);

  const existing = await loadExistingBooks();
  console.log(`Loaded ${existing.books.length} existing books for in-memory duplicate checks.`);
  console.log(`\n${all.length} swept; ${candidates.length} with >= ${MIN_WEEKS} charting week(s)${DRY ? ' (dry run — no writes)' : ''}\n`);

  const res = { added: 0, dupe: 0, noMatch: 0, failed: 0 };
  let n = 0;
  for (const c of candidates) {
    n++;
    try {
      const detail = await lookupByIsbn(c.isbn13);
      if (!detail || !detail.title) { res.noMatch++; await sleep(1100); continue; }

      const duplicate = findDuplicateLocal(existing, detail.title, c.author);
      if (duplicate) { res.dupe++; await sleep(1100); continue; }

      const genres = normalizeBookGenres(c.genres);
      if (DRY) {
        console.log(`+ [${String(c.weeks).padStart(2)}w] "${detail.title}" by ${c.author} (${detail.releaseYear || '?'}) — ${genres.join(', ')}`);
        res.added++; await sleep(1100); continue;
      }

      const created = await prisma.mediaItem.create({
        data: {
          mediaType: 'BOOK',
          title: detail.title,
          slug: await uniqueSlug(slugify(detail.title, detail.releaseYear)),
          releaseYear: detail.releaseYear,
          // Auto-publish, matching sync-new-books.js. An ISBN-exact lookup
          // doesn't carry the wrong-edition risk that made the earlier
          // fuzzy-matched batch worth queueing for review.
          verified: true,
          description: detail.description || null,
          imageUrl: detail.imageUrl || null,
          genres,
          authors: await connectPersons(c.author ? [c.author] : []),
        },
      });
      // Keep the in-memory index current, or a title charting on two lists
      // under slightly different ISBNs would be inserted twice in one run.
      const row = { id: created.id, title: detail.title, slug: created.slug, authors: c.author ? [{ name: c.author }] : [] };
      existing.books.push(row);
      if (c.author) {
        const k = c.author.toLowerCase();
        if (!existing.byAuthor.has(k)) existing.byAuthor.set(k, []);
        existing.byAuthor.get(k).push(row);
      }

      res.added++;
      if (res.added % 50 === 0) console.log(`  …${n}/${candidates.length} processed, ${res.added} added`);
    } catch (err) {
      console.log(`✗ "${c.title}" (${c.isbn13}) — ${err.message}`);
      res.failed++;
    }
    await sleep(1100);
  }

  console.log(`\nDone. ${DRY ? 'Would add' : 'Added'} ${res.added}, already present ${res.dupe}, no ISBN match ${res.noMatch}, failed ${res.failed}.`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
