// Reconnaissance only — no writes. For each year 2000-2026, discovers TV
// shows from major networks + streaming providers (scripted drama/comedy
// and documentary, excluding News/Talk — see discoverNewTvShows), then
// checks which are NOT already in the DB as a parent show (parentId: null).
require('dotenv').config();
const prisma = require('C:/Users/jalex/Documents/GitHub/isitstillgood/src/lib/prisma');
const { discoverNewTvShows } = require('C:/Users/jalex/Documents/GitHub/isitstillgood/src/services/mediaLookup');

// with_networks IDs — empirically verified this session by querying each and
// inspecting real show output (TMDB has no reliable name-to-ID search for
// networks, unlike movie companies via /search/company).
const NETWORK_IDS = [
  49,  // HBO
  174, // AMC
  88,  // FX
  67,  // Showtime
  6,   // NBC
  16,  // CBS
  2,   // ABC
  19,  // Fox
  71,  // The CW
  4,   // BBC One
  318, // Starz
];
const PROVIDER_NAMES = [
  'Netflix', 'Amazon Prime Video', 'Disney Plus', 'Max', 'Hulu',
  'Apple TV Plus', 'Paramount Plus', 'Peacock',
];

function normTitle(t) { return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

async function main() {
  const startYear = 2000;
  const endYear = new Date().getFullYear();

  console.log('Loading existing DB parent TV shows for comparison...');
  const existing = await prisma.mediaItem.findMany({
    where: { mediaType: 'TV_SHOW', parentId: null },
    select: { title: true, releaseYear: true },
  });
  const existingSet = new Set();
  for (const e of existing) {
    if (!e.releaseYear) continue;
    for (let dy = -1; dy <= 1; dy++) existingSet.add(`${normTitle(e.title)}|${e.releaseYear + dy}`);
  }
  console.log(`${existing.length} existing parent shows loaded.\n`);

  const allCandidates = new Map(); // tmdbId -> {title, releaseYear}
  const byYearCounts = {};

  for (let year = startYear; year <= endYear; year++) {
    const since = `${year}-01-01`;
    const until = `${year}-12-31`;
    try {
      const results = await discoverNewTvShows({ sinceDate: since, untilDate: until, networkIds: NETWORK_IDS, providerNames: PROVIDER_NAMES });
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
  missing.sort((a, b) => (a.releaseYear || 0) - (b.releaseYear || 0) || a.title.localeCompare(b.title));

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total unique candidates ${startYear}-${endYear}: ${allCandidates.size}`);
  console.log(`Not currently in database: ${missing.length}`);

  const fs = require('fs');
  fs.writeFileSync(
    'C:/Users/jalex/AppData/Local/Temp/claude/C--Users-jalex-Documents-GitHub-isitstillgood/e2623e02-e5ec-4ff2-8687-a0781bd04abe/scratchpad/missing-tv-shows.json',
    JSON.stringify({ byYearCounts, missing }, null, 2)
  );
  console.log('Full list written to missing-tv-shows.json');

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
