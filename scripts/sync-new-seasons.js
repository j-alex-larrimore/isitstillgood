// Checks every existing TV parent show for season-count changes on TMDB and
// creates any season rows that exist on TMDB but not yet in the DB.
// Complementary to sync-new-tv.js, which only catches brand-new shows
// premiering their first season — this is the "Season 6 just dropped for a
// show we already have" case, which discoverNewTvShows() can't see since it
// filters on a show's original first_air_date, not per-season air dates.
//
// Usage: node scripts/sync-new-seasons.js [--dry-run]
//
// Runs against every TV parent row with a tmdbId (~9,700+ after the
// historical backfill), so this is a full-catalog sweep every time, not an
// incremental one — TMDB has no "shows updated since X" endpoint to narrow
// it further. One lightweight detail call per show; the heavier season-cast
// call only fires for shows where a genuinely new season is found.
//
// verified:true on new season rows, matching the rest of the auto-publish
// pipeline (sync-new-releases.js, sync-new-tv.js).
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons } = require('../src/lib/mediaHelpers');
const { getTvSeasonNumbers, getTvSeasonCast } = require('../src/services/mediaLookup');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const shows = await prisma.mediaItem.findMany({
    where: { mediaType: 'TV_SHOW', parentId: null, tmdbId: { not: null } },
    select: {
      id: true, title: true, tmdbId: true, genres: true,
      cast: { select: { name: true } },
      seasonEntries: { select: { seasonNumber: true } },
    },
  });
  console.log(`Checking ${shows.length} existing TV shows for new seasons${dryRun ? ' (dry run)' : ''}...\n`);

  let newSeasonCount = 0;
  let showsWithNewSeasons = 0;

  for (const show of shows) {
    try {
      const { seasonNumbers, totalSeasons } = await getTvSeasonNumbers(show.tmdbId);
      const existingNumbers = new Set(show.seasonEntries.map(s => s.seasonNumber));
      const missing = seasonNumbers.filter(n => !existingNumbers.has(n));

      if (missing.length) {
        showsWithNewSeasons++;
        newSeasonCount += missing.length;
        console.log(`"${show.title}": missing season(s) ${missing.join(', ')}`);

        if (!dryRun) {
          const mainCastNames = new Set(show.cast.map(c => c.name.toLowerCase()));
          for (const n of missing) {
            await sleep(200);
            const season = await getTvSeasonCast(show.tmdbId, n);
            if (!season) continue;
            const excludedCast = show.cast.map(c => c.name).filter(name => !season.cast.some(c => c.toLowerCase() === name.toLowerCase()));
            const guestCast = season.cast.filter(name => !mainCastNames.has(name.toLowerCase()));
            const seasonSlug = await uniqueSlug(slugify(`${show.title} Season ${n}`, season.releaseYear));
            await prisma.mediaItem.create({
              data: {
                mediaType: 'TV_SHOW',
                title: `${show.title} — Season ${n}`,
                slug: seasonSlug,
                releaseYear: season.releaseYear ? parseInt(season.releaseYear) : null,
                verified: true,
                parentId: show.id,
                seasonNumber: n,
                genres: show.genres,
                excludedCast,
                cast: await connectPersons(guestCast),
              },
            });
          }
          await prisma.mediaItem.update({ where: { id: show.id }, data: { seasons: totalSeasons } });
        }
      }
    } catch (err) {
      console.log(`✗ "${show.title}" — ${err.message}`);
    }
    await sleep(150);
  }

  console.log(`\nDone. ${newSeasonCount} new season(s) found across ${showsWithNewSeasons} show(s) (of ${shows.length} checked).`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
