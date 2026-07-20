// One-time cleanup of book genre data — Open Library's raw `subject` field
// (and to a lesser extent Google Books categories) got stored directly as
// "genres" during import, which is really a bag of Library-of-Congress
// subject headings ("Married people", "Brothers and sisters", "Social life
// and customs"), not genres. This remaps everything through
// normalizeBookGenres() (src/lib/mediaHelpers.js) against a curated,
// closed genre vocabulary — anything that doesn't map to a real genre is
// dropped rather than kept as noise.
//
// Usage: node scripts/clean-book-genres.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { normalizeBookGenres } = require('../src/lib/mediaHelpers');

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK' },
    select: { id: true, title: true, slug: true, genres: true },
  });
  console.log(`Total books: ${books.length}\n`);

  let changed = 0, unchanged = 0, becameEmpty = 0;
  const emptyExamples = [];
  const sampleChanges = [];

  for (const b of books) {
    const before = b.genres || [];
    const after = normalizeBookGenres(before);
    if (arraysEqual(before, after)) { unchanged++; continue; }
    changed++;
    if (after.length === 0 && before.length > 0) {
      becameEmpty++;
      if (emptyExamples.length < 20) emptyExamples.push({ title: b.title, before });
    }
    if (sampleChanges.length < 40) sampleChanges.push({ title: b.title, before, after });

    if (!dryRun) {
      await prisma.mediaItem.update({ where: { id: b.id }, data: { genres: after } });
    }
  }

  console.log(`${dryRun ? 'Would change' : 'Changed'}: ${changed}`);
  console.log(`Unchanged (already clean or no genres): ${unchanged}`);
  console.log(`Became empty (had junk-only genres): ${becameEmpty}\n`);

  console.log('=== Sample changes ===');
  for (const c of sampleChanges) {
    console.log(`"${c.title}"`);
    console.log(`  before: ${JSON.stringify(c.before)}`);
    console.log(`  after:  ${JSON.stringify(c.after)}`);
  }

  if (emptyExamples.length) {
    console.log('\n=== Books that would end up with ZERO genres (sample) ===');
    for (const e of emptyExamples) console.log(`  - "${e.title}": ${JSON.stringify(e.before)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
