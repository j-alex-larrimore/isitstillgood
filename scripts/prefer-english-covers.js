// Swaps a book's cover for one from an English edition, where the current
// cover demonstrably isn't from one.
//
//   node scripts/prefer-english-covers.js --dry-run     (do this first)
//   node scripts/prefer-english-covers.js [--limit=N]
//
// Policy: this catalogue carries books written in English or the English
// translation of a book, so the cover should be the one an English reader would
// recognise off a shelf.
//
// The problem, as documented next to searchOpenLibrary in mediaLookup.js: Open
// Library's work-level cover is picked from an aggregated record spanning every
// translated edition, with no language filtering. audit-book-covers.js triages
// for this and flagged 3,196 of 6,392 books as "at risk" — but at-risk means
// "this work has editions in more than one language", not "this cover is
// wrong". Sampling found most were already English.
//
// So this does not trust the triage. For each book it asks the only question
// that matters: is the cover id we currently store among the covers of this
// work's ENGLISH editions? If yes, nothing happens. If no, and an English
// edition has a cover, that one is used.
//
// Open Library rather than Google Books deliberately. Google is the quota this
// project has exhausted twice, and fixing 3,196 books through it would take
// three days of daily allowance; Open Library's editions endpoint answers the
// question directly, for free, in one call per book.
//
// Never clears a cover. A book whose work has no English edition with a cover
// keeps what it has — a possibly-foreign cover beats a blank card.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');

const UA = 'isitstillgood-covers/1.0 (j.alex.larrimore@gmail.com)';
const PACE_MS = 130;
const CHECKPOINT = path.join(__dirname, '_english-covers-checkpoint.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1], 10) || Infinity;

const loadDone = () => { try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).done); } catch { return new Set(); } };
const saveDone = d => fs.writeFileSync(CHECKPOINT, JSON.stringify({ done: [...d] }, null, 0));

const coverIdOf = url => (String(url || '').match(/\/b\/id\/(\d+)-/) || [])[1] || null;

async function englishCovers(workId, attempt = 0){
  try {
    const r = await fetch(`https://openlibrary.org/works/${workId}/editions.json?limit=200`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    await sleep(PACE_MS);
    if (r.status === 429 || (r.status >= 500 && attempt < 2)) {
      await sleep(2000 * (attempt + 1));
      return englishCovers(workId, attempt + 1);
    }
    if (!r.ok) return null;
    const j = await r.json();
    const eng = (j.entries || []).filter(e =>
      (e.languages || []).some(l => /\/eng$/.test(l.key || '')) && Array.isArray(e.covers) && e.covers[0] > 0);
    // Most-used cover among English editions, so one oddity doesn't win.
    const tally = new Map();
    for (const e of eng) {
      const id = String(e.covers[0]);
      tally.set(id, (tally.get(id) || 0) + 1);
    }
    return { all: new Set(tally.keys()), best: [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null };
  } catch (err) {
    if (attempt < 2) { await sleep(2000 * (attempt + 1)); return englishCovers(workId, attempt + 1); }
    return null;
  }
}

(async () => {
  const done = loadDone();
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', imageUrl: { contains: 'covers.openlibrary' } },
    select: { id: true, title: true, imageUrl: true, goodreadsId: true },
    orderBy: { title: 'asc' },
  });
  const queue = books.filter(b => /^OL\d+W$/.test(b.goodreadsId || '') && !done.has(b.id)).slice(0, LIMIT);

  console.log(`${books.length} books on an Open Library cover · ${queue.length} to check${DRY ? '   [DRY RUN]' : ''}\n`);

  let swapped = 0, alreadyEnglish = 0, noEnglish = 0, failed = 0, n = 0;

  for (const b of queue) {
    const current = coverIdOf(b.imageUrl);
    const res = await englishCovers(b.goodreadsId);
    n++;

    if (!res) { failed++; continue; }
    if (current && res.all.has(current)) { alreadyEnglish++; done.add(b.id); }
    else if (!res.best) { noEnglish++; done.add(b.id); }   // keep what we have
    else {
      swapped++;
      console.log(`   ${b.title.slice(0, 44).padEnd(45)} ${current || 'none'} → ${res.best}`);
      if (!DRY) {
        await prisma.mediaItem.update({
          where: { id: b.id },
          data: { imageUrl: `https://covers.openlibrary.org/b/id/${res.best}-L.jpg` },
        });
        done.add(b.id);
      }
    }

    if (n % 200 === 0) {
      if (!DRY) saveDone(done);
      console.log(`  …${n}/${queue.length} · swapped ${swapped} · already English ${alreadyEnglish} · no English cover ${noEnglish}`);
    }
  }
  if (!DRY) saveDone(done);

  console.log(`\nchecked ${n} · swapped ${swapped} · already English ${alreadyEnglish} · no English cover available ${noEnglish} · lookup failures ${failed}`);
  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
