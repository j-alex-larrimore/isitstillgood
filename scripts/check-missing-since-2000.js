// Reconnaissance only — no writes. For each year 2000-2026, runs the same
// discover queries sync-new-releases.js would use (major studios OR major
// streaming providers), then checks which results are NOT already in the DB.
require('dotenv').config();
const prisma = require('C:/Users/jalex/Documents/GitHub/isitstillgood/src/lib/prisma');
const { discoverNewMovies } = require('C:/Users/jalex/Documents/GitHub/isitstillgood/src/services/mediaLookup');

const STUDIO_NAMES = [
  'Walt Disney Pictures', 'Marvel Studios', 'Pixar', '20th Century Studios',
  'Lucasfilm Ltd.', 'Warner Bros. Pictures', 'Universal Pictures',
  'Columbia Pictures', 'Paramount Pictures', 'Lionsgate',
  'DreamWorks Animation', 'A24', 'Legendary Pictures', 'New Line Cinema',
  'Focus Features',
];
const PROVIDER_NAMES = [
  'Netflix', 'Amazon Prime Video', 'Disney Plus', 'Max', 'Hulu',
  'Apple TV Plus', 'Paramount Plus', 'Peacock',
];

function normTitle(t) { return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

async function main() {
  const startYear = 2000;
  const endYear = new Date().getFullYear();

  console.log('Loading existing DB movies for comparison...');
  const existing = await prisma.mediaItem.findMany({ where: { mediaType: 'MOVIE' }, select: { title: true, releaseYear: true } });
  const existingSet = new Set();
  for (const e of existing) {
    if (!e.releaseYear) continue;
    for (let dy = -1; dy <= 1; dy++) existingSet.add(`${normTitle(e.title)}|${e.releaseYear + dy}`);
  }
  console.log(`${existing.length} existing movies loaded.\n`);

  const allCandidates = new Map(); // tmdbId -> {title, year}
  const byYearCounts = {};

  for (let year = startYear; year <= endYear; year++) {
    const since = `${year}-01-01`;
    const until = `${year}-12-31`;
    try {
      const results = await discoverNewMovies({ sinceDate: since, untilDate: until, studioNames: STUDIO_NAMES, providerNames: PROVIDER_NAMES });
      let newThisYear = 0;
      for (const r of results) {
        if (!allCandidates.has(r.tmdbId)) {
          allCandidates.set(r.tmdbId, r);
          const key = `${normTitle(r.title)}|${r.releaseYear}`;
          if (!existingSet.has(key)) newThisYear++;
        }
      }
      byYearCounts[year] = { total: results.length, new: newThisYear };
      console.log(`${year}: ${results.length} candidates from TMDB, ${newThisYear} not in DB`);
    } catch (err) {
      console.log(`${year}: ERROR - ${err.message}`);
      byYearCounts[year] = { total: 0, new: 0, error: err.message };
    }
  }

  const missing = [...allCandidates.values()].filter(r => !existingSet.has(`${normTitle(r.title)}|${r.releaseYear}`));
  missing.sort((a, b) => a.year - b.year || a.title.localeCompare(b.title));

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total unique candidates ${startYear}-${endYear}: ${allCandidates.size}`);
  console.log(`Not currently in database: ${missing.length}`);

  const fs = require('fs');
  fs.writeFileSync(
    'C:/Users/jalex/AppData/Local/Temp/claude/C--Users-jalex-Documents-GitHub-isitstillgood/e2623e02-e5ec-4ff2-8687-a0781bd04abe/scratchpad/missing-since-2000.json',
    JSON.stringify({ byYearCounts, missing }, null, 2)
  );
  console.log('Full list written to missing-since-2000.json');

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
