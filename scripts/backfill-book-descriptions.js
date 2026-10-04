// Fills missing book descriptions from Google Books.
//
//   node scripts/backfill-book-descriptions.js --dry-run
//   node scripts/backfill-book-descriptions.js            (run daily until done)
//
// Open Library cannot do this job. It has the ISBNs, covers, subjects and dates
// that enrich-books-from-openlibrary.js uses, but it does not have blurbs: a
// sample of 25 books missing a description found that ZERO of them had one on
// Open Library. Google Books does, which makes its ~1,000/day quota the binding
// constraint rather than a preference.
//
// So this is deliberately a multi-day job. It checkpoints, stops cleanly the
// moment the daily quota is refused, and prints how far it got. Run it again
// tomorrow. ~1,580 books means roughly two days.
//
// Matching is by ISBN wherever possible — an exact key, and we hold every
// edition's. Only when a book has no ISBN at all does it fall back to a
// title+author search, and that result is accepted only if the author agrees:
// title alone is how Yann Martel's "Self" ended up wearing Brandon Sanderson's
// cover, and a wrong blurb reads as true in a way a missing one never does.
//
// English only, matching the catalogue policy, and nothing under 80 characters
// — a one-line stub reads as an error on the page rather than as information.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');
const { normalizeTitleForSearch } = require('../src/lib/mediaHelpers');
const { cleanBookDescription } = require('../src/services/mediaLookup');

const KEY = process.env.GOOGLE_BOOKS_API_KEY;
// 750ms keeps under the "queries per minute per user" ceiling. An earlier
// script used 45ms, tripped it after ~100 books, and misreported a per-minute
// limit as the daily one — which made a 20-minute job look like a week.
const PACE_MS = 750;
const MIN_CHARS = 80;
const CHECKPOINT = path.join(__dirname, '_book-descriptions-checkpoint.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1], 10) || Infinity;

const loadDone = () => { try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).done); } catch { return new Set(); } };
const saveDone = d => fs.writeFileSync(CHECKPOINT, JSON.stringify({ done: [...d] }, null, 0));

const nameTokens = names => new Set(
  names.flatMap(n => normalizeTitleForSearch(String(n || '')).split(' ')).filter(t => t.length > 2));

let quotaHit = null;

// Three outcomes, and conflating them is how a backfill poisons its own
// checkpoint: {ok, json} means the question was answered, {down} means the
// service could not answer, {quota} means stop for the day. An earlier version
// returned null for all of them, so a run during an outage would have marked
// all 1,576 books "done" with no description and every later run would have
// skipped them forever.
async function gb(url){
  let r;
  try { r = await fetch(url); }
  catch { await sleep(PACE_MS); return { down: true }; }
  await sleep(PACE_MS);

  if (r.status === 429) {
    const body = await r.json().catch(() => null);
    quotaHit = (body?.error?.message || '').match(/limit '([^']+)'/)?.[1] || 'rate limit';
    return { quota: true };
  }
  // Google answers an exhausted or unhealthy project with 503, and sometimes
  // with a 200 carrying no totalItems at all — both were seen on a key whose
  // unkeyed equivalent was returning an explicit daily-quota 429.
  if (r.status >= 500) return { down: true };
  if (!r.ok) return { down: true };

  const json = await r.json().catch(() => null);
  if (!json || json.totalItems === undefined) return { down: true };
  return { ok: true, json };
}

// Returns the first English volume carrying a real description.
function pickVolume(json, wantAuthors){
  for (const item of (json?.items || [])) {
    const info = item.volumeInfo || {};
    if (info.language !== 'en') continue;
    const desc = cleanBookDescription(info.description || '');
    if (!desc || desc.trim().length < MIN_CHARS) continue;
    if (wantAuthors?.size) {
      const theirs = nameTokens(info.authors || []);
      if (![...wantAuthors].some(t => theirs.has(t))) continue;
    }
    return desc.trim();
  }
  return null;
}

(async () => {
  if (!KEY) { console.error('GOOGLE_BOOKS_API_KEY not configured — copy it from Railway’s Variables tab into .env'); process.exit(1); }

  const done = loadDone();
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', OR: [{ description: null }, { description: '' }] },
    select: { id: true, title: true, isbns: true, releaseYear: true, authors: { select: { name: true } } },
    orderBy: { title: 'asc' },
  });
  const queue = books.filter(b => !done.has(b.id)).slice(0, LIMIT);

  console.log(`${books.length} books without a description · ${queue.length} to try${DRY ? '   [DRY RUN]' : ''}`);
  console.log(`pacing ${PACE_MS}ms; expect the daily quota to stop this around 1,000 lookups\n`);

  let filled = 0, missed = 0, n = 0, calls = 0, downStreak = 0;

  for (const b of queue) {
    n++;
    const want = nameTokens((b.authors || []).map(a => a.name));
    let desc = null;

    // ISBN first: exact, and we hold every edition's. Capped at 4 so one
    // obscure book cannot eat a large slice of the daily allowance.
    let answered = false;
    for (const isbn of b.isbns.slice(0, 4)) {
      calls++;
      const res = await gb(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent('isbn:' + isbn)}&key=${KEY}`);
      if (res.quota) break;
      if (res.down) { downStreak++; break; }
      answered = true; downStreak = 0;
      desc = pickVolume(res.json, null);   // an ISBN match is already the right book
      if (desc) break;
    }

    if (!desc && !quotaHit && !downStreak && !b.isbns.length) {
      // No ISBN to match on, so fall back to a search — and require the author
      // to agree before believing it.
      const author = b.authors?.[0]?.name;
      const q = `intitle:${b.title}${author ? ` inauthor:${author}` : ''}`;
      calls++;
      const res = await gb(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&key=${KEY}`);
      if (res.down) downStreak++;
      else if (!res.quota) { answered = true; downStreak = 0; desc = pickVolume(res.json, want); }
    }

    if (quotaHit) {
      console.log(`\nSTOPPED — Google Books refused: "${quotaHit}". ${filled} filled this run. Re-run tomorrow; progress is saved.`);
      break;
    }

    if (desc) {
      filled++;
      if (DRY) console.log(`   + ${b.title.slice(0, 44).padEnd(45)} ${desc.slice(0, 54).replace(/\s+/g, ' ')}…`);
      else await prisma.mediaItem.update({ where: { id: b.id }, data: { description: desc } });
    } else if (answered) missed++;
    // Only a book we actually got an answer about is settled. One we could not
    // reach stays in the queue for the next run.
    if (answered) done.add(b.id);

    if (n % 100 === 0) {
      if (!DRY) saveDone(done);
      console.log(`  …${n}/${queue.length} · filled ${filled} · no English blurb ${missed} · ~${calls} lookups used`);
    }
  }
  if (!DRY) saveDone(done);

  const left = await prisma.mediaItem.count({ where: { mediaType: 'BOOK', OR: [{ description: null }, { description: '' }] } });
  console.log(`\ntried ${n} · filled ${filled} · no usable English blurb ${missed} · ~${calls} lookups`);
  console.log(`books still without a description: ${left}`);
  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
