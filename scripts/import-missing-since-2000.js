// One-off backfill: imports every major-studio/streaming movie (2000-present)
// found missing by scripts/check-missing-since-2000.js. Reads its JSON
// output directly (already has exact TMDB IDs from discovery — no title
// search needed, unlike scripts/bulk-import.js), so this is both faster
// and immune to the title-search mismatch risk documented in bulk-import.js.
//
// Usage: node scripts/import-missing-since-2000.js [--dry-run] [--start=N]
// --start resumes from candidate index N (0-based) if a previous run was
// interrupted — check the console output for the last successful index.

require('dotenv').config();
const fs = require('fs');
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, normalizeGenres, findDuplicate } = require('../src/lib/mediaHelpers');
const { getTmdbDetail } = require('../src/services/mediaLookup');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const startArg = args.find(a => a.startsWith('--start='));
  const startIndex = startArg ? parseInt(startArg.slice('--start='.length)) : 0;

  const data = JSON.parse(fs.readFileSync(
    'C:/Users/jalex/AppData/Local/Temp/claude/C--Users-jalex-Documents-GitHub-isitstillgood/e2623e02-e5ec-4ff2-8687-a0781bd04abe/scratchpad/missing-since-2000.json',
    'utf8'
  ));
  const candidates = data.missing;
  console.log(`Loaded ${candidates.length} candidates, starting at index ${startIndex}${dryRun ? ' (dry run — no writes)' : ''}\n`);

  const results = { added: [], skipped: [], failed: [] };

  for (let i = startIndex; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const detail = await getTmdbDetail(candidate.tmdbId, 'movie');
      const releaseYear = detail.releaseYear ? parseInt(detail.releaseYear) : null;

      const duplicate = await findDuplicate({
        title: detail.title, mediaType: 'MOVIE', tmdbId: detail.tmdbId, releaseYear,
      });
      if (duplicate) {
        results.skipped.push(detail.title);
        if (dryRun) console.log(`[${i}] ⚠ "${detail.title}" — already in database (${duplicate.slug}), skipping`);
        await sleep(300);
        continue;
      }

      if (dryRun) {
        console.log(`[${i}] + "${detail.title}" (${releaseYear || 'year unknown'}) — would be added`);
        results.added.push(detail.title);
        await sleep(300);
        continue;
      }

      const slug = await uniqueSlug(slugify(detail.title, releaseYear));
      await prisma.mediaItem.create({
        data: {
          mediaType: 'MOVIE',
          title: detail.title,
          slug,
          releaseYear,
          verified: false, // review queue, same as every other bulk import this session
          description: detail.description || null,
          imageUrl: detail.imageUrl || null,
          genres: normalizeGenres(detail.genres || []),
          tmdbId: detail.tmdbId,
          tmdbRating: detail.tmdbRating || null,
          directors: await connectPersons(detail.directors || []),
          cast: await connectPersons(detail.cast || []),
        },
      });
      results.added.push(detail.title);
      if (i % 25 === 0) console.log(`[${i}/${candidates.length}] ✓ "${detail.title}" (${releaseYear || 'year unknown'})`);
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
