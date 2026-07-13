// One-time historical video game backfill — the game equivalent of the
// movie major-studio backfill and TV backfill. Pulls every IGDB "main game"
// (game_type=0) released 1970-present with rating_count > RATING_COUNT_FLOOR,
// matching the threshold confirmed with the user during reconnaissance
// (scripts/check-missing-games.js: ~8,343 candidates / ~7,979 missing).
//
// Unlike scripts/sync-new-games.js (which auto-publishes verified:true since
// it's a narrow, curated weekly window), this is a broad one-time historical
// dump — imported as verified:false into the admin review queue, matching
// the precedent set by the movie/book historical backfills.
//
// Usage: node scripts/backfill-games.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, normalizeGenres, findDuplicate } = require('../src/lib/mediaHelpers');
const { discoverNewGames } = require('../src/services/mediaLookup');

const RATING_COUNT_FLOOR = 10;
const SINCE_DATE = '1970-01-01';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const until = new Date().toISOString().split('T')[0];

  console.log(`Discovering games ${SINCE_DATE} to ${until}, rating_count > ${RATING_COUNT_FLOOR}...`);
  const candidates = await discoverNewGames({ sinceDate: SINCE_DATE, untilDate: until, ratingCountFloor: RATING_COUNT_FLOOR });
  console.log(`Found ${candidates.length} candidate(s) from IGDB.\n`);

  const results = { added: [], skipped: [], failed: [] };

  for (const g of candidates) {
    try {
      const duplicate = await findDuplicate({ title: g.title, mediaType: 'VIDEO_GAME', igdbId: g.igdbId, releaseYear: g.releaseYear });
      if (duplicate) {
        results.skipped.push(g.title);
        continue;
      }

      const genres = normalizeGenres(g.genres || []);

      if (dryRun) {
        results.added.push(g.title);
        continue;
      }

      const slug = await uniqueSlug(slugify(g.title, g.releaseYear));
      await prisma.mediaItem.create({
        data: {
          mediaType: 'VIDEO_GAME',
          title: g.title,
          slug,
          releaseYear: g.releaseYear,
          verified: false,
          description: g.description || null,
          imageUrl: g.imageUrl || null,
          genres,
          openCriticId: g.igdbId,
          openCriticScore: g.rating || null,
        },
      });
      results.added.push(g.title);
    } catch (err) {
      results.failed.push({ title: g.title, error: err.message });
    }
    if (!dryRun) await sleep(50);
  }

  console.log(`Done. ${dryRun ? 'Would add' : 'Added'} ${results.added.length}, skipped (dupe) ${results.skipped.length}, failed ${results.failed.length}.`);
  if (results.failed.length) {
    console.log('\nFailures:');
    for (const f of results.failed) console.log(`  - ${f.title}: ${f.error}`);
  }
  if (dryRun) {
    console.log('\nSample of titles that would be added:');
    for (const t of results.added.slice(0, 40)) console.log(`  + ${t}`);
    if (results.added.length > 40) console.log(`  ...and ${results.added.length - 40} more`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
