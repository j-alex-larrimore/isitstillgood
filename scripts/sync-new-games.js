// Auto-syncs newly-released and soon-to-release video games via IGDB —
// the game equivalent of sync-new-releases.js/sync-new-tv.js. Meant to run
// on a schedule (see .github/workflows/sync-new-releases.yml).
//
// Two passes, since a single popularity metric doesn't work across both:
//   1. Recently released games (last N days) — filtered by rating_count,
//      same as the historical backfill, since these have had at least a
//      little time to accumulate ratings.
//   2. Upcoming games (next ~90 days) — filtered by hypes instead, IGDB's
//      pre-release anticipation metric, since an unreleased game has zero
//      accumulated ratings by definition. Confirmed empirically: GTA VI
//      correctly surfaces as the most-hyped upcoming title.
//
// verified:true — auto-publish, matching the movie/TV/book syncs' choice.
//
// Usage: node scripts/sync-new-games.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, normalizeGameGenres, findDuplicate } = require('../src/lib/mediaHelpers');
const { discoverNewGames } = require('../src/services/mediaLookup');

const RATING_COUNT_FLOOR = 10; // matches the historical backfill's threshold
const HYPES_FLOOR = 5;         // upcoming games — lower bar since hype accumulates pre-release more slowly than ratings do post-release

const sleep = ms => new Promise(r => setTimeout(r, ms));
function dateStr(d) { return d.toISOString().split('T')[0]; }

async function importCandidates(candidates, dryRun, results) {
  for (const g of candidates) {
    try {
      const duplicate = await findDuplicate({ title: g.title, mediaType: 'VIDEO_GAME', releaseYear: g.releaseYear });
      if (duplicate) {
        console.log(`⚠ "${g.title}" — already in database (${duplicate.slug}), skipping`);
        results.skipped.push(g.title);
        await sleep(200);
        continue;
      }

      const genres = normalizeGameGenres(g.genres || []);

      if (dryRun) {
        console.log(`+ "${g.title}" (${g.releaseYear || 'year unknown'}) — genres: ${genres.join(', ')} — would be added`);
        results.added.push(g.title);
        await sleep(200);
        continue;
      }

      const slug = await uniqueSlug(slugify(g.title, g.releaseYear));
      await prisma.mediaItem.create({
        data: {
          mediaType: 'VIDEO_GAME',
          title: g.title,
          slug,
          releaseYear: g.releaseYear,
          verified: true,
          description: g.description || null,
          imageUrl: g.imageUrl || null,
          genres,
          openCriticId: g.igdbId,
          openCriticScore: g.rating || null,
        },
      });
      console.log(`✓ "${g.title}" (${g.releaseYear || 'year unknown'}) — added`);
      results.added.push(g.title);
    } catch (err) {
      console.log(`✗ "${g.title}" — ${err.message}`);
      results.failed.push({ title: g.title, error: err.message });
    }
    await sleep(200);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const results = { added: [], skipped: [], failed: [] };

  const until = new Date();
  const since = new Date(until.getTime() - 8 * 24 * 60 * 60 * 1000);
  console.log(`Recently released (${dateStr(since)} to ${dateStr(until)}), rating_count > ${RATING_COUNT_FLOOR}...`);
  const recent = await discoverNewGames({ sinceDate: dateStr(since), untilDate: dateStr(until), ratingCountFloor: RATING_COUNT_FLOOR });
  console.log(`Found ${recent.length} candidate(s).\n`);
  await importCandidates(recent, dryRun, results);

  const upcomingUntil = new Date(until.getTime() + 90 * 24 * 60 * 60 * 1000);
  console.log(`\nUpcoming (${dateStr(until)} to ${dateStr(upcomingUntil)}), hypes > ${HYPES_FLOOR}...`);
  const upcoming = await discoverNewGames({ sinceDate: dateStr(until), untilDate: dateStr(upcomingUntil), hypesFloor: HYPES_FLOOR });
  console.log(`Found ${upcoming.length} candidate(s).\n`);
  await importCandidates(upcoming, dryRun, results);

  console.log(`\nDone. Added ${results.added.length}, skipped ${results.skipped.length}, failed ${results.failed.length}.`);
  if (results.failed.length) {
    console.log('\nFailures:');
    for (const f of results.failed) console.log(`  - ${f.title}: ${f.error}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
