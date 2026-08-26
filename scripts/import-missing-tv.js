// Bulk backfill: imports every TV show found missing by the network/
// provider discovery scan (scripts/check-missing-tv-shows.js) plus the
// Emmy-nominee research pass, merged into scratchpad/tv-import-final.json
// (see the merge step run inline in this session — exact TMDB IDs, no
// title search needed). For each show: creates the parent row plus one
// child row per season with that season's guest-only cast (season cast
// minus main cast) and excludedCast (main cast minus season cast — see
// scripts/import-tv-show-with-seasons.js, the pilot this was based on).
// Also applies the Schools/Police/Legal/Courtroom/Medical setting-genre
// heuristic (scripts/apply-setting-genres-tv.js) inline per show, using the
// same TMDB keywords call, rather than a separate full pass afterward.
//
// verified:true on both parent and season rows — auto-publish, per explicit
// direction (contrast with the movie backfill, which used verified:false).
//
// Usage: node scripts/import-missing-tv.js [--dry-run] [--start=N]
require('dotenv').config();
const fs = require('fs');
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, connectCast, normalizeGenres, findDuplicate, settingGenresFor } = require('../src/lib/mediaHelpers');
const { getTmdbDetail, getTvSeasonCast: getSeasonCast, getTvKeywords: getKeywords } = require('../src/services/mediaLookup');

const SCRATCH = 'C:/Users/jalex/AppData/Local/Temp/claude/C--Users-jalex-Documents-GitHub-isitstillgood/e2623e02-e5ec-4ff2-8687-a0781bd04abe/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const startArg = args.find(a => a.startsWith('--start='));
  const startIndex = startArg ? parseInt(startArg.slice('--start='.length)) : 0;

  const candidates = JSON.parse(fs.readFileSync(`${SCRATCH}/tv-import-final.json`, 'utf8'));
  console.log(`Loaded ${candidates.length} candidates, starting at index ${startIndex}${dryRun ? ' (dry run)' : ''}\n`);

  const results = { added: [], skipped: [], failed: [] };

  for (let i = startIndex; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const detail = await getTmdbDetail(candidate.tmdbId, 'tv');
      const releaseYear = detail.releaseYear ? parseInt(detail.releaseYear) : null;

      const duplicate = await findDuplicate({ title: detail.title, mediaType: 'TV_SHOW', tmdbId: detail.tmdbId, releaseYear });
      if (duplicate) {
        results.skipped.push(detail.title);
        if (i % 25 === 0) console.log(`[${i}] ⚠ "${detail.title}" — already in database (${duplicate.slug}), skipping`);
        await sleep(200);
        continue;
      }

      const keywords = await getKeywords(candidate.tmdbId);
      const settingGenres = settingGenresFor(keywords);
      const genres = normalizeGenres([...(detail.genres || []), ...settingGenres]);

      if (dryRun) {
        results.added.push(detail.title);
        console.log(`[${i}] + "${detail.title}" (${releaseYear || 'year unknown'}) — ${detail.seasons || 0} season(s), genres: ${genres.join(', ')}`);
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
        const season = await getSeasonCast(candidate.tmdbId, n);
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

      results.added.push(detail.title);
      if (i % 25 === 0) console.log(`[${i}/${candidates.length}] ✓ "${detail.title}" (${releaseYear || 'year unknown'}), ${detail.seasons || 0} season(s), genres: ${genres.join(', ')}`);
    } catch (err) {
      results.failed.push({ index: i, title: candidate.title, error: err.message });
      console.log(`[${i}] ✗ "${candidate.title}" — ${err.message}`);
    }
    await sleep(300);
  }

  console.log(`\nDone. Added ${results.added.length}, skipped ${results.skipped.length}, failed ${results.failed.length}.`);
  if (results.failed.length) {
    console.log('\nFailures (resume with --start=<lowest index> to retry):');
    for (const f of results.failed) console.log(`  [${f.index}] ${f.title}: ${f.error}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
