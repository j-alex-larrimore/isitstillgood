// Refreshes streaming/rent/buy availability for every movie and TV parent
// show, sourced from JustWatch via TMDB's watch/providers endpoint.
//
// Usage: node scripts/sync-streaming-providers.js [--dry-run]
//
// Full-catalog sweep every run (~27,000+ items after the historical
// backfill) — same shape as sync-new-seasons.js's full sweep, one
// lightweight call per item, no way to ask TMDB for "just what changed".
// US region only (see getWatchProviders in mediaLookup.js). TV seasons are
// skipped — TMDB's watch/providers endpoint is show-level, not per-season,
// so only parent rows (parentId: null) are queried.
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { getWatchProviders } = require('../src/services/mediaLookup');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A script holding one Prisma connection open for the better part of an
// hour, mostly idle between calls (see the sleep() below), turned out to
// occasionally hit a connection reset against Railway's proxy — confirmed
// live, logged as "Error in PostgreSQL connection: ... ConnectionReset".
// Prisma reconnects on its own for the *next* query, but the query that was
// in flight when it happened still fails — so retry it once here rather
// than losing that item's update or, worse, letting the whole run die.
async function updateWithRetry(id, data, retries = 2, delayMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await prisma.mediaItem.update({ where: { id }, data });
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const items = await prisma.mediaItem.findMany({
    where: {
      tmdbId: { not: null },
      OR: [
        { mediaType: 'MOVIE' },
        { mediaType: 'TV_SHOW', parentId: null },
      ],
    },
    select: { id: true, title: true, mediaType: true, tmdbId: true },
  });
  console.log(`Checking ${items.length} movies/TV shows for streaming availability${dryRun ? ' (dry run)' : ''}...\n`);

  let updated = 0;
  let withProviders = 0;

  for (const item of items) {
    try {
      const mediaKind = item.mediaType === 'TV_SHOW' ? 'tv' : 'movie';
      const providers = await getWatchProviders(item.tmdbId, mediaKind);
      const hasAny = providers && (providers.flatrate.length || providers.rent.length || providers.buy.length);
      if (hasAny) withProviders++;

      // providers is only ever null when the TMDB fetch itself failed (see
      // getWatchProviders) — a successful check always writes a real
      // object, even an empty one, so item.html can tell "checked, nothing
      // available" apart from "never checked".
      if (!dryRun && providers) {
        await updateWithRetry(item.id, { streamingProviders: providers, streamingUpdatedAt: new Date() });
      }
      updated++;
    } catch (err) {
      console.log(`✗ "${item.title}" — ${err.message}`);
    }
    if (updated % 1000 === 0) console.log(`...${updated}/${items.length} checked so far`);
    await sleep(150);
  }

  console.log(`\nDone. ${updated}/${items.length} checked, ${withProviders} have at least one streaming/rent/buy option.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
