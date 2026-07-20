// Auto-syncs newly-published books from NYT current bestseller lists into
// the database — the book equivalent of sync-new-releases.js/sync-new-tv.js.
// Meant to run on a schedule (see .github/workflows/sync-new-releases.yml).
//
// Unlike the movie/TV syncs, this isn't built on Google Books at all for
// discovery — Google Books has no reliable "what's new" query (see the
// investigation that led here: orderBy=newest doesn't actually sort by
// recency, and publisher/date-range queries returned zero results for a
// major publisher's current-year catalog). The NYT Books API's current-week
// bestseller lists are a real "what's current" signal instead. Google Books
// is still used, but only for a precise ISBN lookup (via the exact ISBN-13
// NYT provides) to get description/cover/pageCount — an ISBN-exact lookup
// doesn't have the wrong-edition ambiguity that title/author fuzzy search
// does, so this doesn't need bulk-import.js's scoreBookCandidate heuristics.
//
// GENRE: per explicit direction, Google Books' own genre/category field is
// unreliable and is NOT used here — genres are assigned from which NYT list
// the book appeared on (see LIST_GENRE_MAP) instead.
//
// verified:true — auto-publish, matching the movie/TV sync's choice.
//
// Requires GOOGLE_BOOKS_API_KEY (existing) and NYT_API_KEY (new — see
// CLAUDE.md for how to get one) in .env.
//
// Usage: node scripts/sync-new-books.js [--dry-run]

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, normalizeBookGenres, findDuplicate } = require('../src/lib/mediaHelpers');
const { getNytBestsellerList, searchGoogleBooksByIsbn } = require('../src/services/mediaLookup');

// A curated subset of NYT's bestseller lists (see
// https://api.nytimes.com/svc/books/v3/lists/names.json for the full set) —
// deliberately excludes narrow/miscellaneous lists (self-help sub-genres,
// manga, etc.) to keep this focused, same spirit as STUDIO_NAMES/
// PROVIDER_NAMES in sync-new-releases.js. Extend if a category feels missing.
// 'paperback-nonfiction' was retired by NYT (confirmed via a real 404, not
// rate-limiting) — 'combined-print-and-e-book-nonfiction' covers the same
// ground and is confirmed live.
const LIST_GENRE_MAP = {
  'hardcover-fiction': ['Fiction'],
  'trade-fiction-paperback': ['Fiction'],
  'hardcover-nonfiction': ['Nonfiction'],
  'combined-print-and-e-book-nonfiction': ['Nonfiction'],
  'young-adult-hardcover': ['Young Adult', 'Fiction'],
  'childrens-middle-grade-hardcover': ['Juvenile Fiction'],
  'picture-books': ['Juvenile Fiction'],
  'graphic-books-and-manga': ['Graphic Novels'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Checking NYT bestseller lists: ${Object.keys(LIST_GENRE_MAP).join(', ')}${dryRun ? ' (dry run — no writes)' : ''}\n`);

  // Dedupe by ISBN — a book (esp. combined print+e-book lists vs. their
  // hardcover-only counterpart) often appears on more than one list in the
  // same week. First list it's seen on wins for genre assignment.
  const candidates = new Map(); // isbn13 -> { title, author, genres }
  for (const [listName, genres] of Object.entries(LIST_GENRE_MAP)) {
    try {
      const books = await getNytBestsellerList(listName);
      for (const b of books) {
        if (!b.isbn13 || candidates.has(b.isbn13)) continue;
        candidates.set(b.isbn13, { title: b.title, author: b.author, genres });
      }
      console.log(`"${listName}": ${books.length} book(s)`);
    } catch (err) {
      console.log(`"${listName}": ERROR - ${err.message}`);
    }
    // NYT's free API tier allows ~5 requests/minute — 13s keeps every call
    // (including retries inside fetchWithRetry) safely under that.
    await sleep(13000);
  }
  console.log(`\n${candidates.size} unique book(s) across all lists.\n`);

  const results = { added: [], skipped: [], failed: [] };

  for (const [isbn13, candidate] of candidates) {
    try {
      const detail = await searchGoogleBooksByIsbn(isbn13);
      if (!detail) {
        console.log(`⚠ "${candidate.title}" — no Google Books match for ISBN ${isbn13}, skipping`);
        results.skipped.push(candidate.title);
        await sleep(1100);
        continue;
      }

      const duplicate = await findDuplicate({
        title: detail.title, mediaType: 'BOOK', releaseYear: detail.releaseYear,
        authors: candidate.author ? [candidate.author] : undefined,
      });
      if (duplicate) {
        console.log(`⚠ "${detail.title}" — already in database (${duplicate.slug}), skipping`);
        results.skipped.push(detail.title);
        await sleep(1100);
        continue;
      }

      const genres = normalizeBookGenres(candidate.genres);

      if (dryRun) {
        console.log(`+ "${detail.title}" by ${candidate.author} (${detail.releaseYear || 'year unknown'}) — genres: ${genres.join(', ')} — would be added`);
        results.added.push(detail.title);
        await sleep(1100);
        continue;
      }

      const slug = await uniqueSlug(slugify(detail.title, detail.releaseYear));
      await prisma.mediaItem.create({
        data: {
          mediaType: 'BOOK',
          title: detail.title,
          slug,
          releaseYear: detail.releaseYear,
          verified: true,
          description: detail.description || null,
          imageUrl: detail.imageUrl || null,
          genres,
          goodreadsId: null, // Google Books results aren't stored under goodreadsId — see bulk-import.js
          authors: await connectPersons(candidate.author ? [candidate.author] : []),
        },
      });
      console.log(`✓ "${detail.title}" by ${candidate.author} (${detail.releaseYear || 'year unknown'}) — added`);
      results.added.push(detail.title);
    } catch (err) {
      console.log(`✗ "${candidate.title}" — ${err.message}`);
      results.failed.push({ title: candidate.title, isbn13, error: err.message });
    }
    await sleep(1100);
  }

  console.log(`\nDone. Added ${results.added.length}, skipped ${results.skipped.length}, failed ${results.failed.length}.`);
  if (results.failed.length) {
    // Failures here are usually a transient Google Books 503 (already
    // retried a few times inside fetchWithRetry) rather than a real, fixable
    // problem — worth a manual ISBN lookup later, not a sign of a bug.
    console.log('\nFailures (ISBN included for manual re-check):');
    for (const f of results.failed) console.log(`  - ${f.title} (${f.isbn13}): ${f.error}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
