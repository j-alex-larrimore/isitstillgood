// Fills MediaItem.isbn13 for books, so a Goodreads export can be matched on
// ISBN instead of title+author.
//
// Two sources, chosen per book by what its goodreadsId actually holds — that
// field's name is a historical accident and it carries a mix:
//   Google Books volume id (~72%) -> volumes/<id> gives industryIdentifiers
//   Open Library work id   (~28%) -> works/<id>/editions gives isbn_13/isbn_10
//
// Open Library has no hard quota, so it runs first and free. Google Books
// enforces BOTH a per-minute and a ~1,100/day cap (see
// scripts/audit-cover-mismatches.js for the same lesson), so that half is
// paced and resumable — re-run on consecutive days until it reports COMPLETE.
//
// Self-resuming by construction: a book with isbn13 set drops out of the
// query, so no checkpoint file is needed. Books it has already failed to
// find an ISBN for will be retried on each run; that is deliberate, since
// the upstream record may gain one later.
//
// Usage: node scripts/backfill-isbns.js [--source=ol|gb] [--limit=N] [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const KEY = process.env.GOOGLE_BOOKS_API_KEY;
const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find(a => a.startsWith('--source=')) || '').split('=')[1] || null;
const LIMIT = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1], 10) || Infinity;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Under Google's per-minute-per-user ceiling. The audit script learned this
// the hard way at 45ms.
const GB_PACE_MS = 750;
const OL_PACE_MS = 120;

const digits = s => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();

// ISBN-10 -> ISBN-13 is deterministic: prefix 978, drop the old check digit,
// recompute mod-10. Storing one normalized form means one column and one
// lookup rather than matching against two.
function isbn10to13(raw) {
  const s = digits(raw);
  if (s.length !== 10) return null;
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}
function normalizeIsbn(raw) {
  const s = digits(raw);
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10) return isbn10to13(s);
  return null;
}

async function fromOpenLibrary(workId) {
  const r = await fetch(`https://openlibrary.org/works/${workId}/editions.json?limit=20`, {
    headers: { 'User-Agent': 'isitstillgood-isbn-backfill/1.0 (j.alex.larrimore@gmail.com)' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  for (const e of j.entries || []) {
    const hit = (e.isbn_13 || []).map(normalizeIsbn).find(Boolean)
             || (e.isbn_10 || []).map(normalizeIsbn).find(Boolean);
    if (hit) return hit;
  }
  return null;
}

async function fromGoogleBooks(volumeId) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes/${volumeId}?key=${KEY}`);
  if (r.status === 429) {
    const body = await r.json().catch(() => null);
    const limit = (body?.error?.message || '').match(/limit '([^']+)'/)?.[1] || 'unknown';
    return { quota: limit };
  }
  if (!r.ok) return null;
  const j = await r.json();
  const ids = j.volumeInfo?.industryIdentifiers || [];
  const thirteen = ids.find(i => i.type === 'ISBN_13');
  const ten = ids.find(i => i.type === 'ISBN_10');
  return normalizeIsbn(thirteen?.identifier) || normalizeIsbn(ten?.identifier) || null;
}

(async () => {
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', isbn13: null, goodreadsId: { not: null } },
    select: { id: true, title: true, goodreadsId: true },
  });

  const ol = books.filter(b => /^OL\d+W$/.test(b.goodreadsId));
  const gb = books.filter(b => !/^OL\d+W$/.test(b.goodreadsId));
  const haveIsbn = await prisma.mediaItem.count({ where: { mediaType: 'BOOK', isbn13: { not: null } } });
  const totalBooks = await prisma.mediaItem.count({ where: { mediaType: 'BOOK' } });

  console.log(`${totalBooks} books · ${haveIsbn} already have an ISBN · ${books.length} to try`);
  console.log(`  open library: ${ol.length}   google books: ${gb.length}${DRY ? '   (DRY RUN)' : ''}\n`);

  let found = 0, miss = 0, done = 0, quotaKind = null;

  async function run(list, label, fetcher, pace) {
    for (const b of list) {
      if (done >= LIMIT) return;
      let isbn;
      try { isbn = await fetcher(b.goodreadsId); } catch { miss++; done++; continue; }
      if (isbn && isbn.quota) { quotaKind = isbn.quota; return; }
      if (isbn) {
        if (!DRY) await prisma.mediaItem.update({ where: { id: b.id }, data: { isbn13: isbn } });
        found++;
      } else miss++;
      done++;
      if (done % 100 === 0) console.log(`  ${label}: ${done} processed, ${found} found`);
      await sleep(pace);
    }
  }

  if (ONLY !== 'gb') await run(ol, 'open library', fromOpenLibrary, OL_PACE_MS);
  if (ONLY !== 'ol' && !quotaKind) {
    if (!KEY) console.log('\nGOOGLE_BOOKS_API_KEY missing — skipping the Google Books half.');
    else await run(gb, 'google books', fromGoogleBooks, GB_PACE_MS);
  }

  const now = await prisma.mediaItem.count({ where: { mediaType: 'BOOK', isbn13: { not: null } } });
  console.log(`\nprocessed ${done} · found ${found} · no isbn upstream ${miss}`);
  console.log(`books with an ISBN: ${now}/${totalBooks} (${((now / totalBooks) * 100).toFixed(1)}%)`);
  if (quotaKind) {
    console.log(/per day/i.test(quotaKind)
      ? `STOPPED — Google daily quota (${quotaKind}) exhausted; re-run tomorrow`
      : `STOPPED — hit ${quotaKind}; re-run to resume`);
  } else console.log('COMPLETE for the books that had a usable id');

  await prisma.$disconnect();
})();
