// One-off, read-only: resolves the Emmy-nominee title list (raw research
// output, "Title | Year" per line, saved to scratchpad/emmy-raw.txt) against
// TMDB TV search, cross-checks against the existing DB and against
// scratchpad/missing-tv-shows.json (the network/provider discovery backfill),
// and writes the incremental candidates — Emmy-nominated shows not already
// covered by either — to scratchpad/missing-emmy-tv.json.
require('dotenv').config();
const fs = require('fs');
const prisma = require('../src/lib/prisma');
const { searchTmdb } = require('../src/services/mediaLookup');

const SCRATCH = 'C:/Users/jalex/AppData/Local/Temp/claude/C--Users-jalex-Documents-GitHub-isitstillgood/e2623e02-e5ec-4ff2-8687-a0781bd04abe/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/[.,:;!?'"]/g, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickBestMatch(candidates, year, expectedTitle) {
  if (!candidates.length) return null;
  let pool = candidates;
  const normExpected = normTitle(expectedTitle);
  const exactTitleMatches = candidates.filter(c => normTitle(c.title) === normExpected);
  if (exactTitleMatches.length) pool = exactTitleMatches;
  if (year) {
    const closeYear = pool
      .map(c => ({ c, diff: Math.abs((parseInt(c.releaseYear) || 0) - year) }))
      .sort((a, b) => a.diff - b.diff)[0];
    if (closeYear && closeYear.diff <= 2) return closeYear.c;
  }
  return pool[0];
}

async function main() {
  const lines = fs.readFileSync(`${SCRATCH}/emmy-raw.txt`, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const rows = lines.map(l => {
    const [title, year] = l.split('|').map(s => s.trim());
    return { title, year: year ? parseInt(year) : null };
  });
  console.log(`Loaded ${rows.length} Emmy-nominee rows.\n`);

  console.log('Loading existing DB parent TV shows...');
  const existing = await prisma.mediaItem.findMany({ where: { mediaType: 'TV_SHOW', parentId: null }, select: { title: true, releaseYear: true } });
  const existingSet = new Set();
  for (const e of existing) {
    for (let dy = -2; dy <= 2; dy++) existingSet.add(`${normTitle(e.title)}|${(e.releaseYear || 0) + dy}`);
    existingSet.add(`${normTitle(e.title)}|0`); // year-unknown fallback
  }
  console.log(`${existing.length} existing parent shows loaded.\n`);

  let networkBacklog = { missing: [] };
  try {
    networkBacklog = JSON.parse(fs.readFileSync(`${SCRATCH}/missing-tv-shows.json`, 'utf8'));
  } catch { console.log('(no missing-tv-shows.json found — skipping that cross-check)'); }
  const backlogTmdbIds = new Set(networkBacklog.missing.map(m => m.tmdbId));

  const resolved = [];
  const alreadyInDb = [];
  const alreadyInBacklog = [];
  const notFound = [];

  for (let i = 0; i < rows.length; i++) {
    const { title, year } = rows[i];
    try {
      const candidates = await searchTmdb(title, 'tv', year);
      const best = pickBestMatch(candidates, year, title);
      if (!best) {
        notFound.push({ title, year });
        console.log(`[${i}] ✗ "${title}" (${year}) — no TMDB match`);
        await sleep(250);
        continue;
      }
      const key1 = `${normTitle(best.title)}|${parseInt(best.releaseYear) || 0}`;
      if (existingSet.has(key1) || existingSet.has(`${normTitle(best.title)}|0`)) {
        alreadyInDb.push({ title: best.title, tmdbId: best.tmdbId });
      } else if (backlogTmdbIds.has(best.tmdbId)) {
        alreadyInBacklog.push({ title: best.title, tmdbId: best.tmdbId });
      } else {
        resolved.push({ tmdbId: best.tmdbId, title: best.title, releaseYear: parseInt(best.releaseYear) || null, sourceTitle: title, sourceYear: year });
        console.log(`[${i}] + "${best.title}" (${best.releaseYear}) — new candidate`);
      }
    } catch (err) {
      notFound.push({ title, year, error: err.message });
      console.log(`[${i}] ✗ "${title}" — ERROR: ${err.message}`);
    }
    await sleep(250);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total Emmy rows: ${rows.length}`);
  console.log(`Already in DB: ${alreadyInDb.length}`);
  console.log(`Already covered by network/provider backlog: ${alreadyInBacklog.length}`);
  console.log(`No TMDB match found: ${notFound.length}`);
  console.log(`New incremental candidates: ${resolved.length}`);

  fs.writeFileSync(`${SCRATCH}/missing-emmy-tv.json`, JSON.stringify({ resolved, alreadyInDb, alreadyInBacklog, notFound }, null, 2));
  console.log(`\nWritten to missing-emmy-tv.json`);

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
