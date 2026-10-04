// Fills in whatever a book is missing — description, cover, genres, ISBNs,
// year — from Open Library.
//
//   node scripts/enrich-books-from-openlibrary.js --dry-run     (do this first)
//   node scripts/enrich-books-from-openlibrary.js [--limit=N]
//
// Only ever ADDS. An existing value is never overwritten, so a description
// someone wrote or a cover an earlier pass verified cannot be clobbered by a
// worse one from a bulk run.
//
// Open Library for all of it: free, unmetered, no key. Google Books would be
// the obvious alternative for descriptions, but at ~1,000 lookups a day
// against 1,581 missing descriptions that is two days of quota before counting
// retries, and this project has stalled on that quota twice already.
//
// A book with no OL work id gets one by searching title+author, and the id is
// written back to goodreadsId so later runs and audits start from it. The
// search result is only accepted when the author agrees — title alone matched
// Yann Martel's "Self" to Brandon Sanderson's "Shadows of Self" once already,
// which is the mistake audit-cover-mismatches.js exists to catch.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');
const { normalizeBookGenres, normalizeTitleForSearch, slugify, uniqueSlug } = require('../src/lib/mediaHelpers');
const { cleanBookDescription, filterOpenLibraryGenres } = require('../src/services/mediaLookup');

const UA = 'isitstillgood-enrich/1.0 (j.alex.larrimore@gmail.com)';
const PACE_MS = 130;
const CHECKPOINT = path.join(__dirname, '_enrich-books-checkpoint.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1], 10) || Infinity;

const loadDone = () => { try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).done); } catch { return new Set(); } };
const saveDone = d => fs.writeFileSync(CHECKPOINT, JSON.stringify({ done: [...d] }, null, 0));

const digits = s => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();
function isbn10to13(raw){
  const s = digits(raw);
  if (s.length !== 10) return null;
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}
function normalizeIsbn(raw){
  const s = digits(raw);
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10) return isbn10to13(s);
  return null;
}

const nameTokens = names => new Set(
  names.flatMap(n => normalizeTitleForSearch(String(n || '')).split(' ')).filter(t => t.length > 2));

async function getJson(url, attempt = 0){
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    await sleep(PACE_MS);
    if ((r.status === 429 || r.status >= 500) && attempt < 2) {
      await sleep(2000 * (attempt + 1));
      return getJson(url, attempt + 1);
    }
    return r.ok ? r.json() : null;
  } catch {
    if (attempt < 2) { await sleep(1500 * (attempt + 1)); return getJson(url, attempt + 1); }
    return null;
  }
}

// A cover id can resolve to a ~1KB stub rather than art; these are served
// chunked so there is no content-length to read — the bytes have to be fetched.
async function isHealthyCover(id){
  try {
    const r = await fetch(`https://covers.openlibrary.org/b/id/${id}-L.jpg`, { headers: { 'User-Agent': UA } });
    await sleep(PACE_MS);
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length >= 2000 && buf[0] === 0xFF && buf[1] === 0xD8;
  } catch { return false; }
}

async function findWorkId(book){
  const q = new URLSearchParams({ title: book.title, limit: '5', fields: 'key,title,author_name' });
  const author = book.authors?.[0]?.name;
  if (author) q.set('author', author);
  const j = await getJson(`https://openlibrary.org/search.json?${q}`);
  const want = nameTokens((book.authors || []).map(a => a.name));
  for (const d of (j?.docs || [])) {
    if (normalizeTitleForSearch(d.title || '') !== normalizeTitleForSearch(book.title)) continue;
    // Author has to agree. Title alone is how "Self" ended up wearing
    // "Shadows of Self"'s cover.
    if (want.size) {
      const theirs = nameTokens(d.author_name || []);
      if (![...want].some(t => theirs.has(t))) continue;
    }
    const id = String(d.key || '').split('/').pop();
    if (/^OL\d+W$/.test(id)) return id;
  }
  return null;
}

const saneYear = y => (Number.isFinite(y) && y >= 1400 && y <= new Date().getFullYear() + 2) ? y : null;

(async () => {
  const done = loadDone();
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK' },
    select: { id: true, title: true, slug: true, goodreadsId: true, description: true,
              imageUrl: true, genres: true, isbns: true, isbn13: true, releaseYear: true,
              authors: { select: { name: true } } },
    orderBy: { title: 'asc' },
  });

  const needs = b => !b.description?.trim() || !b.imageUrl || !b.genres.length || !b.isbns.length || b.releaseYear == null;
  const queue = books.filter(b => needs(b) && !done.has(b.id)).slice(0, LIMIT);

  console.log(`${books.length} books · ${queue.length} missing something${DRY ? '   [DRY RUN]' : ''}\n`);

  const filled = { description: 0, cover: 0, genres: 0, isbns: 0, year: 0, workId: 0 };
  let touched = 0, noWork = 0, n = 0;

  for (const b of queue) {
    n++;
    let workId = /^OL\d+W$/.test(b.goodreadsId || '') ? b.goodreadsId : null;
    const searched = !workId;
    if (!workId) workId = await findWorkId(b);
    if (!workId) { noWork++; done.add(b.id); continue; }

    const [work, eds] = await Promise.all([
      getJson(`https://openlibrary.org/works/${workId}.json`),
      getJson(`https://openlibrary.org/works/${workId}/editions.json?limit=200`),
    ]);
    if (!work) { noWork++; done.add(b.id); continue; }

    const data = {};
    const entries = eds?.entries || [];

    if (searched) { data.goodreadsId = workId; filled.workId++; }

    if (!b.description?.trim()) {
      const raw = typeof work.description === 'string' ? work.description : work.description?.value || '';
      const clean = cleanBookDescription(raw);
      // A one-line stub is not worth storing; it reads as an error on the page.
      if (clean && clean.trim().length >= 80) { data.description = clean; filled.description++; }
    }

    if (!b.genres.length) {
      const g = normalizeBookGenres(filterOpenLibraryGenres(work.subjects || []));
      if (g.length) { data.genres = g; filled.genres++; }
    }

    if (!b.isbns.length && entries.length) {
      const set = new Set();
      for (const e of entries) for (const k of ['isbn_13', 'isbn_10']) for (const v of (e[k] || [])) {
        const nn = normalizeIsbn(v); if (nn) set.add(nn);
      }
      if (set.size) {
        data.isbns = [...set];
        if (!b.isbn13) data.isbn13 = [...set][0];
        filled.isbns++;
      }
    }

    if (b.releaseYear == null) {
      let y = null;
      const m = String(work.first_publish_date || '').match(/\d{4}/);
      if (m) y = +m[0];
      if (!y) {
        const years = entries.map(e => { const mm = String(e.publish_date || '').match(/\d{4}/); return mm ? +mm[0] : null; })
          .filter(x => x && x >= 1400);
        if (years.length) y = Math.min(...years);
      }
      const sane = saneYear(y);
      if (sane) { data.releaseYear = sane; filled.year++; }
    }

    if (!b.imageUrl) {
      // Prefer an English edition's cover, matching the English-only policy,
      // and fall back to the work's own only if no English edition has one.
      const eng = entries.filter(e => (e.languages || []).some(l => /\/eng$/.test(l.key || '')) && e.covers?.[0] > 0);
      const tally = new Map();
      for (const e of eng) { const id = String(e.covers[0]); tally.set(id, (tally.get(id) || 0) + 1); }
      const ranked = [...tally.entries()].sort((a, c) => c[1] - a[1]).map(([id]) => id);
      if (work.covers?.[0] > 0) ranked.push(String(work.covers[0]));
      for (const id of ranked) {
        if (await isHealthyCover(id)) { data.imageUrl = `https://covers.openlibrary.org/b/id/${id}-L.jpg`; filled.cover++; break; }
      }
    }

    if (Object.keys(data).length) {
      touched++;
      const what = Object.keys(data).filter(k => k !== 'goodreadsId').join(', ');
      if (DRY) console.log(`   + ${b.title.slice(0, 46).padEnd(47)} ${what}`);
      else await prisma.mediaItem.update({ where: { id: b.id }, data });
    }
    done.add(b.id);

    if (n % 200 === 0) {
      if (!DRY) saveDone(done);
      console.log(`  …${n}/${queue.length} · filled ${touched} · desc ${filled.description} cover ${filled.cover} genres ${filled.genres} isbns ${filled.isbns} year ${filled.year}`);
    }
  }
  if (!DRY) saveDone(done);

  console.log(`\nchecked ${n} · enriched ${touched} · no Open Library work found ${noWork}`);
  console.log(`descriptions ${filled.description} · covers ${filled.cover} · genres ${filled.genres} · ISBN sets ${filled.isbns} · years ${filled.year} · work ids learned ${filled.workId}`);
  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
