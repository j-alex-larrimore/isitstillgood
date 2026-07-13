// Reconnaissance only — no writes. Sweeps 1970-2026 year by year via IGDB
// discover (rating_count > 10, main games only — see discoverNewGames'
// header comment for why game_type=0, not the deprecated category field),
// and checks which results are NOT already in the DB.
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { discoverNewGames } = require('../src/services/mediaLookup');

const RATING_COUNT_FLOOR = 10;

function normTitle(t) { return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

async function main() {
  const startYear = 1970;
  const endYear = new Date().getFullYear();

  console.log('Loading existing DB games for comparison...');
  const existing = await prisma.mediaItem.findMany({ where: { mediaType: 'VIDEO_GAME' }, select: { title: true, releaseYear: true } });
  const existingSet = new Set();
  for (const e of existing) {
    if (!e.releaseYear) continue;
    for (let dy = -1; dy <= 1; dy++) existingSet.add(`${normTitle(e.title)}|${e.releaseYear + dy}`);
  }
  console.log(`${existing.length} existing games loaded.\n`);

  const allCandidates = new Map(); // igdbId -> {title, releaseYear}
  const byYearCounts = {};

  for (let year = startYear; year <= endYear; year++) {
    const since = `${year}-01-01`;
    const until = `${year}-12-31`;
    try {
      const results = await discoverNewGames({ sinceDate: since, untilDate: until, ratingCountFloor: RATING_COUNT_FLOOR });
      let newThisYear = 0;
      for (const r of results) {
        if (!allCandidates.has(r.igdbId)) {
          allCandidates.set(r.igdbId, r);
          const key = `${normTitle(r.title)}|${r.releaseYear}`;
          if (!existingSet.has(key)) newThisYear++;
        }
      }
      byYearCounts[year] = { total: results.length, new: newThisYear };
      console.log(`${year}: ${results.length} candidates from IGDB, ${newThisYear} not in DB`);
    } catch (err) {
      console.log(`${year}: ERROR - ${err.message}`);
      byYearCounts[year] = { total: 0, new: 0, error: err.message };
    }
  }

  const missing = [...allCandidates.values()].filter(r => !existingSet.has(`${normTitle(r.title)}|${r.releaseYear}`));
  missing.sort((a, b) => (a.releaseYear || 0) - (b.releaseYear || 0) || a.title.localeCompare(b.title));

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total unique candidates ${startYear}-${endYear}: ${allCandidates.size}`);
  console.log(`Not currently in database: ${missing.length}`);

  const fs = require('fs');
  fs.writeFileSync(
    'C:/Users/jalex/AppData/Local/Temp/claude/C--Users-jalex-Documents-GitHub-isitstillgood/e2623e02-e5ec-4ff2-8687-a0781bd04abe/scratchpad/missing-games.json',
    JSON.stringify({ byYearCounts, missing }, null, 2)
  );
  console.log('Full list written to missing-games.json');

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
