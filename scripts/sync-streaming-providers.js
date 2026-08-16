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

      if (!dryRun) {
        await prisma.mediaItem.update({
          where: { id: item.id },
          data: { streamingProviders: providers || undefined, streamingUpdatedAt: new Date() },
        });
      }
      updated++;
    } catch (err) {
      console.log(`✗ "${item.title}" — ${err.message}`);
    }
    await sleep(150);
  }

  console.log(`\nDone. ${updated}/${items.length} checked, ${withProviders} have at least one streaming/rent/buy option.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
