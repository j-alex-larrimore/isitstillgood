// Auto-syncs newly-premiered TV shows from major networks and streaming
// services into the database — the TV equivalent of sync-new-releases.js.
// Meant to run on a schedule (see .github/workflows/sync-new-releases.yml).
//
// Usage:
//   node scripts/sync-new-tv.js [--dry-run] [--days=N]
//
// --days sets the lookback window (default 8, same 1-day overlap buffer
// over a weekly schedule as the movie sync).
//
// SCOPE NOTE: discoverNewTvShows() filters by a show's overall
// first_air_date, so this only catches brand-new shows premiering their
// first season. It does NOT catch new seasons of shows already in the DB —
// that's scripts/sync-new-seasons.js, a separate job.
//
// verified:true on both parent and season rows, matching the movie sync's
// auto-publish choice — see that file's header comment for the reasoning.
// Applies the Schools/Police/Legal/Courtroom/Medical setting-genre
// heuristic inline (settingGenresFor in src/lib/mediaHelpers.js).
//
// Requires TMDB_READ_ACCESS_TOKEN in .env (same as bulk-import.js).

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, connectCast, normalizeGenres, findDuplicate, settingGenresFor } = require('../src/lib/mediaHelpers');
const { discoverNewTvShows, getTmdbDetail, getTvSeasonCast, getTvKeywords } = require('../src/services/mediaLookup');

// with_networks IDs — empirically verified against real TMDB output (see
// scripts/check-missing-tv-shows.js header for how these were confirmed).
const NETWORK_IDS = [49, 174, 88, 67, 6, 16, 2, 19, 71, 4, 318]; // HBO, AMC, FX, Showtime, NBC, CBS, ABC, Fox, CW, BBC One, Starz
const PROVIDER_NAMES = [
  'Netflix', 'Amazon Prime Video', 'Disney Plus', 'Max', 'Hulu',
  'Apple TV Plus', 'Paramount Plus', 'Peacock',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function dateStr(d) { return d.toISOString().split('T')[0]; }

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const daysArg = args.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.slice('--days='.length)) : 8;

  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  console.log(`Looking for TV shows premiering ${dateStr(since)} to ${dateStr(until)}${dryRun ? ' (dry run — no writes)' : ''}\n`);

  const candidates = await discoverNewTvShows({
    sinceDate: dateStr(since),
    untilDate: dateStr(until),
    networkIds: NETWORK_IDS,
    providerNames: PROVIDER_NAMES,
  });
  console.log(`Found ${candidates.length} candidate(s) from TMDB discover.\n`);

  const results = { added: [], skipped: [], failed: [] };

  for (const candidate of candidates) {
    try {
      const detail = await getTmdbDetail(candidate.tmdbId, 'tv');
      const releaseYear = detail.releaseYear ? parseInt(detail.releaseYear) : null;

      const duplicate = await findDuplicate({ title: detail.title, mediaType: 'TV_SHOW', tmdbId: detail.tmdbId, releaseYear });
      if (duplicate) {
        console.log(`⚠ "${detail.title}" — already in database (${duplicate.slug}), skipping`);
        results.skipped.push(detail.title);
        await sleep(250);
        continue;
      }

      const keywords = await getTvKeywords(candidate.tmdbId);
      const genres = normalizeGenres([...(detail.genres || []), ...settingGenresFor(keywords)]);

      if (dryRun) {
        console.log(`+ "${detail.title}" (${releaseYear || 'year unknown'}) — ${detail.seasons || 0} season(s), genres: ${genres.join(', ')} — would be added`);
        results.added.push(detail.title);
        await sleep(300);
        continue;
      }

      const slug = await uniqueSlug(slugify(detail.title, releaseYear));
      const mainCastData = await connectCast(detail.cast || []);
      const parent = await prisma.mediaItem.create({
        data: {
          mediaType: 'TV_SHOW',
          title: detail.title,
          slug,
          releaseYear,
          verified: true,
          description: detail.description || null,
          imageUrl: detail.imageUrl || null,
          genres,
          tmdbId: detail.tmdbId,
          tmdbRating: detail.tmdbRating || null,
          seasons: detail.seasons || null,
          directors: await connectPersons(detail.directors || []),
          cast: mainCastData.cast,
          castOrder: mainCastData.castOrder,
        },
      });

      const mainCastNames = new Set((detail.cast || []).map(n => n.toLowerCase()));
      for (let n = 1; n <= (detail.seasons || 0); n++) {
        await sleep(200);
        const season = await getTvSeasonCast(candidate.tmdbId, n);
        if (!season) continue;
        const excludedCast = (detail.cast || []).filter(name => !season.cast.some(c => c.toLowerCase() === name.toLowerCase()));
        const guestCast = season.cast.filter(name => !mainCastNames.has(name.toLowerCase()));
        const guestCastData = await connectCast(guestCast);
        const seasonSlug = await uniqueSlug(slugify(`${detail.title} Season ${n}`, season.releaseYear));
        await prisma.mediaItem.create({
          data: {
            mediaType: 'TV_SHOW',
            title: `${detail.title} — Season ${n}`,
            slug: seasonSlug,
            releaseYear: season.releaseYear ? parseInt(season.releaseYear) : null,
            verified: true,
            parentId: parent.id,
            seasonNumber: n,
            genres,
            excludedCast,
            cast: guestCastData.cast,
            castOrder: guestCastData.castOrder,
          },
        });
      }

      console.log(`✓ "${detail.title}" (${releaseYear || 'year unknown'}) — added, ${detail.seasons || 0} season(s)`);
      results.added.push(detail.title);
    } catch (err) {
      console.log(`✗ "${candidate.title}" — ${err.message}`);
      results.failed.push({ title: candidate.title, error: err.message });
    }
    await sleep(300);
  }

  console.log(`\nDone. Added ${results.added.length}, skipped ${results.skipped.length}, failed ${results.failed.length}.`);
  if (results.failed.length) {
    console.log('\nFailures:');
    for (const f of results.failed) console.log(`  - ${f.title}: ${f.error}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
