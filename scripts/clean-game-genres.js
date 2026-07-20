// One-time cleanup of video game genre data. IGDB's raw genre names were
// mostly stored verbatim during import — awkward compound labels ("Hack
// and slash/Beat 'em up"), redundant parenthetical abbreviations
// ("Role-playing (RPG)", "Turn-based strategy (TBS)"), and inconsistent
// splitting of "&"-joined names ("Card & Board Game" surviving unsplit on
// some games while others got "Card"/"Board Game" separately, depending on
// which import path added them). Remaps everything through
// normalizeGameGenres() (src/lib/mediaHelpers.js) — see that function's
// comment for the full cleanup map. Unlike book genres, nothing is dropped:
// IGDB's vocabulary is already curated, so anything not in the map is kept
// as-is.
//
// Usage: node scripts/clean-game-genres.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { normalizeGameGenres } = require('../src/lib/mediaHelpers');

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const games = await prisma.mediaItem.findMany({
    where: { mediaType: 'VIDEO_GAME' },
    select: { id: true, title: true, genres: true },
  });
  console.log(`Total games: ${games.length}\n`);

  let changed = 0, unchanged = 0;
  const sampleChanges = [];

  for (const g of games) {
    const before = g.genres || [];
    const after = normalizeGameGenres(before);
    if (arraysEqual(before, after)) { unchanged++; continue; }
    changed++;
    if (sampleChanges.length < 60) sampleChanges.push({ title: g.title, before, after });

    if (!dryRun) {
      await prisma.mediaItem.update({ where: { id: g.id }, data: { genres: after } });
    }
  }

  console.log(`${dryRun ? 'Would change' : 'Changed'}: ${changed}`);
  console.log(`Unchanged (already clean): ${unchanged}\n`);

  console.log('=== Sample changes ===');
  for (const c of sampleChanges) {
    console.log(`"${c.title}"`);
    console.log(`  before: ${JSON.stringify(c.before)}`);
    console.log(`  after:  ${JSON.stringify(c.after)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
