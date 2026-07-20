// Fixes book titles imported in sentence case ("The learned ladies") instead
// of proper title case ("The Learned Ladies") — a data quality issue with
// Open Library/Google Books source titles, not something normalizeBookGenres
// or any existing helper touches.
//
// Only touches the *title* field. Never regenerates slugs (per CLAUDE.md,
// slugs are stable IDs once created) and never touches non-English titles —
// title-case capitalization rules don't apply to French/Spanish/German/
// Italian titles, so anything that looks foreign (accented characters or a
// foreign stopword as a whole word) is skipped and left for manual review.
//
// Usage: node scripts/fix-title-casing.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const MINOR_WORDS = new Set([
  'a', 'an', 'the',
  'and', 'but', 'or', 'nor', 'for', 'so', 'yet',
  'as', 'at', 'by', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over',
  'per', 'to', 'up', 'via', 'with', 'from', 'about', 'above', 'across',
  'after', 'against', 'along', 'among', 'around', 'before', 'behind',
  'below', 'beneath', 'beside', 'between', 'beyond', 'down', 'during',
  'except', 'inside', 'near', 'since', 'than', 'through', 'toward',
  'towards', 'under', 'until', 'upon', 'within', 'without',
]);

const ACCENTED = /[éèêëàâîïôûùüçœñáíóúäöß]/i;
const FOREIGN_STOPWORD = /\b(de|du|des|la|le|les|un|une|et|el|los|las|una|y|und|der|das|von|il|di|che)\b/i;

function looksForeign(title) {
  return ACCENTED.test(title) || FOREIGN_STOPWORD.test(title);
}

// Additive only — never lowercases anything, even a minor word, since a
// capitalized minor word in the source is usually correct on purpose (e.g.
// the first word of a subtitle after a colon/comma: "Emile, or, On
// Education"). Only turns a lowercase-starting word into a capitalized one.
function toTitleCase(title) {
  const words = title.split(' ');
  return words
    .map((word, i) => {
      const isFirst = i === 0;
      const isLast = i === words.length - 1;
      if (!/^[a-z]/.test(word)) return word;
      const bare = word.replace(/[^A-Za-z']/g, '').toLowerCase();
      if (!isFirst && !isLast && MINOR_WORDS.has(bare)) return word;
      return word.replace(/^([a-z])/, c => c.toUpperCase());
    })
    .join(' ');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK' },
    select: { id: true, title: true },
  });

  const minor = MINOR_WORDS;
  let fixed = 0, skippedForeign = 0, skippedNoChange = 0;

  for (const book of books) {
    const words = book.title.split(/\s+/);
    const needsFix = words.length >= 2 && words.slice(1).some(w => {
      const clean = w.replace(/[^a-zA-Z']/g, '');
      if (!clean || minor.has(clean.toLowerCase()) || clean.length < 3) return false;
      return clean === clean.toLowerCase() && /[a-z]/.test(clean);
    });
    if (!needsFix) continue;

    if (looksForeign(book.title)) {
      skippedForeign++;
      continue;
    }

    const newTitle = toTitleCase(book.title);
    if (newTitle === book.title) { skippedNoChange++; continue; }

    fixed++;
    console.log(`"${book.title}" -> "${newTitle}"`);
    if (!dryRun) {
      await prisma.mediaItem.update({ where: { id: book.id }, data: { title: newTitle } });
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Fixed: ${fixed}`);
  console.log(`Skipped (looks foreign, needs manual review): ${skippedForeign}`);
  console.log(`Skipped (no actual change after transform): ${skippedNoChange}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
