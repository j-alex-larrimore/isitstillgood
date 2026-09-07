// scripts/fix-placeholder-covers.js
//
// Replaces book covers that are really Google Books placeholders.
//
// Google serves several stand-ins with a 200 and a valid image content-type,
// so nothing downstream can tell them from a real cover:
//   * "image not available" — a grey box, ~300-3,000 bytes
//   * "Copyrighted image"   — a cropped fragment of the jacket, ~5,000 bytes
//     (this is what The Lost World was showing: the letters "The L")
// Both are far smaller than a real cover, which runs 30-70KB, so byte size is
// the only reliable tell. The Books API reports imageLinks present for all of
// them.
//
//   node scripts/fix-placeholder-covers.js --dry-run [--limit=N]
//   node scripts/fix-placeholder-covers.js --confirm [--limit=N]
//
// Replacements come from Open Library, matched on title + author, and are
// only accepted if the candidate is itself a real image. Anything without a
// good replacement keeps what it has — a weak cover beats a broken one.

require('dotenv').config();
const prisma = require('../src/lib/prisma');

const CONFIRM = process.argv.includes('--confirm');
const DRY = !CONFIRM;
const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
// Real jacket art is comfortably above this; every placeholder observed is
// well below it.
const MIN_BYTES = parseInt(process.env.MIN_BYTES || '12000', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function byteLength(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return 0;
    return Buffer.from(await r.arrayBuffer()).length;
  } catch { return 0; }
}

async function searchOnce(params) {
  const qs = new URLSearchParams({ ...params, limit: '5' });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://openlibrary.org/search.json?${qs}`);
      if (!r.ok) { await sleep(1200); continue; }
      const d = await r.json();
      for (const doc of d.docs || []) {
        if (!doc.cover_i) continue;
        const url = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
        if (await byteLength(url) >= MIN_BYTES) return url;
        await sleep(300);
      }
      return null;
    } catch { await sleep(1200); }
  }
  return null;
}

async function openLibraryCover(title, author) {
  // Author-scoped first — it's the precise query. But Open Library's author
  // strings don't always match ours punctuation-for-punctuation ("J.R.R.
  // Tolkien" vs "J. R. R. Tolkien"), and an over-strict author filter was
  // returning nothing for books that plainly have covers. Fall back to
  // title-only rather than leaving a placeholder in place.
  if (author) {
    const hit = await searchOnce({ title, author });
    if (hit) return hit;
    await sleep(300);
  }
  return searchOnce({ title });
}

async function main() {
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', imageUrl: { contains: 'books.google.com' } },
    select: { id: true, title: true, slug: true, imageUrl: true, authors: { select: { name: true } } },
  });
  console.log(`Scanning ${books.length} Google-hosted book cover(s) for placeholders (< ${MIN_BYTES} bytes)${DRY ? ' — dry run' : ''}…\n`);

  let scanned = 0, flagged = 0, fixed = 0, noReplacement = 0;
  for (const b of books) {
    if (flagged >= LIMIT) break;
    scanned++;
    const size = await byteLength(b.imageUrl);
    await sleep(90);
    if (size === 0 || size >= MIN_BYTES) continue;

    flagged++;
    const author = b.authors?.[0]?.name || '';
    const replacement = await openLibraryCover(b.title, author);
    await sleep(300);

    if (!replacement) {
      console.log(`  ~ ${b.title.slice(0, 48).padEnd(48)} ${size}b — no better cover found, left alone`);
      noReplacement++;
      continue;
    }
    if (!DRY) {
      await prisma.mediaItem.update({ where: { id: b.id }, data: { imageUrl: replacement } });
    }
    console.log(`  ${DRY ? '+' : '✓'} ${b.title.slice(0, 48).padEnd(48)} ${size}b -> ${replacement}`);
    fixed++;
  }

  console.log(`\nDone. Scanned ${scanned}, placeholders found ${flagged}, ${DRY ? 'would replace' : 'replaced'} ${fixed}, no replacement ${noReplacement}.`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
