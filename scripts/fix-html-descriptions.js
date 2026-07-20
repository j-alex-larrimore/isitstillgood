// Re-cleans book descriptions that still contain raw HTML tags (<p>, <a
// href>, <i>, etc.) — leftover from before getOpenLibraryDetail() ran
// Open Library descriptions through cleanBookDescription() (see
// src/services/mediaLookup.js). Google Books descriptions were always
// cleaned; only Open-Library-sourced rows imported before that fix have
// this problem. Pure string re-clean of already-stored text — no API
// calls, fully deterministic.
//
// Usage: node scripts/fix-html-descriptions.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { cleanBookDescription } = require('../src/services/mediaLookup');

const HTML_TAG = /<[a-z][\s\S]*?>/i;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', description: { not: null } },
    select: { id: true, title: true, description: true },
  });
  const flagged = books.filter(b => HTML_TAG.test(b.description));
  console.log(`Found ${flagged.length} book(s) with raw HTML in their description${dryRun ? ' (dry run)' : ''}...`);

  let fixed = 0;
  for (const book of flagged) {
    const cleaned = cleanBookDescription(book.description);
    if (!cleaned || cleaned === book.description) {
      console.log(`"${book.title}": cleaning made no difference — skipping`);
      continue;
    }
    fixed++;
    console.log(`\n"${book.title}":`);
    console.log(`  OLD: ${book.description.slice(0, 150)}...`);
    console.log(`  NEW: ${cleaned.slice(0, 150)}...`);
    if (!dryRun) {
      await prisma.mediaItem.update({ where: { id: book.id }, data: { description: cleaned } });
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Fixed: ${fixed} / ${flagged.length}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
