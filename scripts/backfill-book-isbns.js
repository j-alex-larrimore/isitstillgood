// Fills MediaItem.isbns — every ISBN-13 a work has across all its editions —
// from Open Library.
//
//   node scripts/backfill-book-isbns.js [--limit N] [--dry-run] [--refresh]
//
// Why the whole set rather than one: a Goodreads or StoryGraph export carries
// the ISBN of the edition that reader shelved, and a work has many. Jurassic
// Park has 94 editions and 73 distinct ISBN-13s. Matching our one stored value
// against their one shelved value is about a 1-in-73 shot on that book, so
// raising single-ISBN coverage would not have fixed importing — only holding
// every ISBN does. scripts/backfill-isbns.js (singular) is the older script
// that fills the canonical isbn13; this one supersedes it for matching and
// also fills isbn13 where it was still empty.
//
// Open Library only. It is free, unmetered, has no key, and its work->editions
// relation is exactly the shape needed. Google Books is deliberately not used:
// it is per-volume, so it cannot enumerate siblings, and its daily quota has
// already cost this project two separate stalled runs.
//
// Deliberately sequential at OL_PACE_MS. Open Library is a nonprofit running
// on donations and this walks their whole catalogue of our books; the older
// backfill cleared 2,041 works at this pace without complaint, so it is a
// known-good rate. Do not add concurrency to make it finish sooner.
//
// Safe to stop and re-run. Progress is the database — a book with a non-empty
// isbns array is skipped — and works Open Library has nothing for go in a
// checkpoint file so repeat runs do not re-ask the same dead ends.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');

const UA = 'isitstillgood-isbn-backfill/1.0 (j.alex.larrimore@gmail.com)';
const OL_PACE_MS = 120;
const WRITE_CHUNK = 100;
const CHECKPOINT = path.join(__dirname, '_book-isbns-checkpoint.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const REFRESH = args.includes('--refresh');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1], 10) || Infinity;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = s => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();

// Same normalization as isbn13, so one comparison covers both columns.
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

const loadCheckpoint = () => {
  try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).none); }
  catch { return new Set(); }
};
const saveCheckpoint = none =>
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ none: [...none] }, null, 0));

async function ol(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  await sleep(OL_PACE_MS);
  if (r.status === 429) return { throttled: true };
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// Every ISBN across every edition of a work. Pages only when a work genuinely
// has more than a thousand editions — vanishingly rare, but a classic will.
async function isbnsForWork(workId) {
  const found = new Set();
  let offset = 0;
  for (;;) {
    const j = await ol(`https://openlibrary.org/works/${workId}/editions.json?limit=1000&offset=${offset}`);
    if (!j) return { isbns: [...found] };
    if (j.throttled) return { throttled: true };
    const entries = j.entries || [];
    for (const e of entries) {
      for (const key of ['isbn_13', 'isbn_10']) {
        for (const v of e[key] || []) {
          const n = normalizeIsbn(v);
          if (n) found.add(n);
        }
      }
    }
    offset += entries.length;
    if (!entries.length || offset >= (j.size || 0)) break;
  }
  return { isbns: [...found] };
}

// Finding the work when we don't already hold its id.
async function workIdFromIsbn(isbn) {
  const j = await ol(`https://openlibrary.org/isbn/${isbn}.json`);
  if (!j || j.throttled) return null;
  const key = (j.works || [])[0]?.key || '';
  return key.split('/').pop() || null;
}
async function workIdFromTitleAuthor(title, author) {
  const q = new URLSearchParams({ title, limit: '1', fields: 'key' });
  if (author) q.set('author', author);
  const j = await ol(`https://openlibrary.org/search.json?${q}`);
  if (!j || j.throttled) return null;
  const key = (j.docs || [])[0]?.key || '';
  return key.split('/').pop() || null;
}

(async () => {
  const none = loadCheckpoint();

  const where = { mediaType: 'BOOK', ...(REFRESH ? {} : { isbns: { isEmpty: true } }) };
  const books = await prisma.mediaItem.findMany({
    where,
    select: { id: true, title: true, isbn13: true, goodreadsId: true, authors: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const eligible = books.filter(b => !none.has(b.id));
  const queue = eligible.slice(0, LIMIT);
  const totalBooks = await prisma.mediaItem.count({ where: { mediaType: 'BOOK' } });

  // Counted separately — conflating the checkpoint with the --limit cut made a
  // first run claim 5,511 dead ends it had never actually asked about.
  const skipped = books.length - eligible.length;
  console.log(`${totalBooks} books · ${books.length} without an ISBN set · ${skipped} known-empty upstream · ${queue.length} to fetch${LIMIT !== Infinity ? ` (--limit ${LIMIT})` : ''}${DRY ? '   [DRY RUN]' : ''}\n`);
  if (!queue.length) { await prisma.$disconnect(); return; }

  let pending = [], processed = 0, withSets = 0, totalIsbns = 0, newCanonical = 0, empty = 0;

  const flush = async () => {
    if (!pending.length || DRY) { pending = []; return; }
    await prisma.$transaction(pending.map(u =>
      prisma.mediaItem.update({ where: { id: u.id }, data: u.data })));
    pending = [];
  };

  for (const b of queue) {
    // Prefer the work id we already hold; otherwise find one. goodreadsId holds
    // a mix of OL work ids and Google Books volume ids despite the name, so the
    // shape has to be checked rather than assumed.
    let workId = /^OL\d+W$/.test(b.goodreadsId || '') ? b.goodreadsId : null;
    if (!workId && b.isbn13) workId = await workIdFromIsbn(b.isbn13);
    if (!workId) workId = await workIdFromTitleAuthor(b.title, b.authors?.[0]?.name);

    let isbns = [];
    if (workId) {
      const res = await isbnsForWork(workId);
      if (res.throttled) {
        console.log('\nSTOPPED — Open Library returned 429. Re-run later; progress is saved.');
        break;
      }
      isbns = res.isbns;
    }

    // Never lose the canonical value, even if Open Library doesn't list it.
    if (b.isbn13 && !isbns.includes(b.isbn13)) isbns.push(b.isbn13);

    processed++;
    if (isbns.length) {
      withSets++; totalIsbns += isbns.length;
      const data = { isbns };
      // Fills the canonical column too where it was still empty — the thing
      // the older singular backfill was for.
      if (!b.isbn13) { data.isbn13 = isbns[0]; newCanonical++; }
      pending.push({ id: b.id, data });
    } else {
      empty++;
      none.add(b.id);
    }

    if (pending.length >= WRITE_CHUNK) { await flush(); saveCheckpoint(none); }
    if (processed % 200 === 0) {
      console.log(`  ${processed}/${queue.length} · with ISBNs ${withSets} · avg ${(totalIsbns / Math.max(withSets, 1)).toFixed(1)} per book · none found ${empty}`);
    }
  }

  await flush();
  saveCheckpoint(none);

  const covered = await prisma.mediaItem.count({ where: { mediaType: 'BOOK', isbns: { isEmpty: false } } });
  const canonical = await prisma.mediaItem.count({ where: { mediaType: 'BOOK', isbn13: { not: null } } });
  console.log(`\nprocessed ${processed} · got ISBNs for ${withSets} · none upstream ${empty}`);
  console.log(`new canonical isbn13 filled: ${newCanonical}`);
  console.log(`books with an ISBN set: ${covered}/${totalBooks} (${(covered / totalBooks * 100).toFixed(1)}%)`);
  console.log(`books with a canonical isbn13: ${canonical}/${totalBooks} (${(canonical / totalBooks * 100).toFixed(1)}%)`);
  if (withSets) console.log(`average ISBNs per matched book: ${(totalIsbns / withSets).toFixed(1)}`);

  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
