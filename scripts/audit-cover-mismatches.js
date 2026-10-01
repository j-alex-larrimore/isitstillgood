// Audits book covers for a failure audit-book-covers.js doesn't look for:
// art that renders perfectly and belongs to a different book entirely.
// That script asks whether a cover is the wrong LANGUAGE or missing; this
// one asks whether it is the wrong BOOK. Read-only — it reports, it never
// writes to MediaItem.
//
// Why this exists: "Weapon of Mercy" (Chris A Jackson, 2017) was showing a
// scanned title page of a Victorian sermon, because Open Library matched on
// the words "weapon" and "mercy" and the real book has no cover anywhere.
// Four more turned up the same way — Yann Martel's "Self" wearing Brandon
// Sanderson's "Shadows of Self", Dakota Krout's "Raze" wearing Tillie Cole's,
// Zola's "Paris" wearing "Le Ventre de Paris", and Sartre's "The Age of
// Reason" wearing Thomas Paine's. All five matched on title alone.
//
// The test: a Google Books cover URL embeds the volume id it came from, so
// fetch THAT volume and check its author against ours. Author is the signal —
// every confirmed error had a plausible title and the wrong person.
//
// Two things learned the hard way, both preserved below:
//   - Compare every name token, not surnames. Some author fields hold
//     "Rick Rubin with Neil Strauss" as one string, whose last word is
//     Strauss, which flagged nine perfectly correct covers.
//   - Asking Open Library whether a WORK owns a cover id does not work as a
//     test: OL commonly stores covers on the edition, so it flags ~90 books
//     of which almost all are fine. That approach was abandoned.
//
// Google Books' free quota (~1,000 calls/day) is below the number of books
// with a Google cover, so this checkpoints and resumes. Re-run it on
// consecutive days until it prints COMPLETE. It shares the API key with the
// weekly sync in .github/workflows/sync-new-releases.yml, so prefer running
// it on a day that job isn't due.
//
// Usage: node scripts/audit-cover-mismatches.js [--reset]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');

const KEY = process.env.GOOGLE_BOOKS_API_KEY;
// Leading underscore: .gitignore treats _*.json as generated scratch data.
const CHECKPOINT = path.join(__dirname, '_cover-audit-checkpoint.json');
const FINDINGS = path.join(__dirname, '_cover-audit-findings.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } };

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// Tokens, not surnames — see the header.
const tokens = names => new Set(names.flatMap(n => norm(n).split(' ')).filter(t => t.length > 2));

(async () => {
  if (!KEY) {
    console.error('GOOGLE_BOOKS_API_KEY is missing from .env — copy it from Railway\'s Variables tab.');
    process.exit(1);
  }
  if (process.argv.includes('--reset')) {
    [CHECKPOINT, FINDINGS].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    console.log('checkpoint cleared\n');
  }

  const done = new Set(load(CHECKPOINT));
  const findings = load(FINDINGS);

  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', imageUrl: { contains: 'books.google.com' } },
    select: { title: true, slug: true, imageUrl: true, authors: { select: { name: true } } },
  });
  const todo = books.filter(b => !done.has(b.slug));
  console.log(`${books.length} books with a Google Books cover · ${done.size} already checked · ${todo.length} to go\n`);

  let n = 0;
  let quotaHit = false;

  for (const b of todo) {
    const volId = (b.imageUrl.match(/[?&]id=([^&]+)/) || [])[1];
    if (!volId) { done.add(b.slug); continue; }

    let data;
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes/${volId}?key=${KEY}`);
      if (res.status === 429) { quotaHit = true; break; }
      if (res.status === 404) {
        findings.push({ kind: 'volume-gone', title: b.title, slug: b.slug, detail: volId });
        done.add(b.slug);
        continue;
      }
      if (!res.ok) { done.add(b.slug); continue; }
      data = await res.json();
    } catch {
      continue;                       // transient — leave it for the next run
    }

    const info = data.volumeInfo || {};
    const ours = tokens(b.authors.map(a => a.name));
    const theirs = tokens(info.authors || []);
    // Only judge when both sides name somebody.
    if (ours.size && theirs.size && ![...ours].some(t => theirs.has(t))) {
      findings.push({
        kind: 'author-mismatch',
        title: b.title,
        slug: b.slug,
        detail: `ours: ${b.authors.map(a => a.name).join(', ')} | cover volume: ${(info.authors || []).join(', ')} — "${info.title}"`,
      });
    }

    done.add(b.slug);
    if (++n % 100 === 0) {
      fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));
      fs.writeFileSync(FINDINGS, JSON.stringify(findings, null, 1));
      console.log(`  ${n}/${todo.length} this run · ${findings.length} findings`);
    }
    await sleep(45);
  }

  fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));
  fs.writeFileSync(FINDINGS, JSON.stringify(findings, null, 1));

  const state = quotaHit ? 'STOPPED ON QUOTA — re-run tomorrow' : 'COMPLETE';
  console.log(`\nthis run: ${n} · total ${done.size}/${books.length} · ${state}`);
  console.log(`findings: ${findings.length}`);
  findings.forEach(f => console.log(`  [${f.kind}] ${f.title}\n      ${f.detail}`));
  if (findings.length) {
    console.log('\nLook at each cover before changing anything — some will be the right');
    console.log('book credited differently, not the wrong book.');
  }

  await prisma.$disconnect();
})();
