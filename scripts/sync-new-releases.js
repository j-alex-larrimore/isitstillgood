// Auto-syncs recently released movies from major studios and streaming
// services into the database. Meant to run on a schedule (see
// .github/workflows/sync-new-releases.yml) — no CSV input, it asks TMDB
// directly for "what came out recently" instead of looking up known titles.
//
// Usage:
//   node scripts/sync-new-releases.js [--dry-run] [--days=N]
//
// --days sets the lookback window (default 8, giving a 1-day overlap buffer
// over a weekly schedule so nothing slips through a scheduling gap).
//
// Unlike scripts/bulk-import.js, items created here are immediately
// verified (visible on the public site right away, no review-queue step) —
// this is a deliberate choice for this pipeline specifically, since it only
// pulls from a curated list of major studios/streamers below, not an open
// discovery feed. Edit STUDIO_NAMES / PROVIDER_NAMES below to tune what
// counts as "major" — names must match TMDB's own company/provider names
// (checked automatically; a typo just means that name silently matches
// nothing, so verify with --dry-run after editing).
//
// Requires TMDB_READ_ACCESS_TOKEN in .env (same as bulk-import.js).

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, connectCast, normalizeGenres, findDuplicate } = require('../src/lib/mediaHelpers');
const { discoverNewMovies, getTmdbDetail } = require('../src/services/mediaLookup');

const STUDIO_NAMES = [
  'Walt Disney Pictures', 'Marvel Studios', 'Pixar', '20th Century Studios',
  'Lucasfilm Ltd.', 'Warner Bros. Pictures', 'Universal Pictures',
  'Columbia Pictures', 'Paramount Pictures', 'Lionsgate',
  'DreamWorks Animation', 'A24', 'Legendary Pictures', 'New Line Cinema',
  'Focus Features',
];

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
  console.log(`Looking for movies released ${dateStr(since)} to ${dateStr(until)} from: ${STUDIO_NAMES.join(', ')} | ${PROVIDER_NAMES.join(', ')}${dryRun ? ' (dry run — no writes)' : ''}\n`);

  const candidates = await discoverNewMovies({
    sinceDate: dateStr(since),
    untilDate: dateStr(until),
    studioNames: STUDIO_NAMES,
    providerNames: PROVIDER_NAMES,
  });
  console.log(`Found ${candidates.length} candidate(s) from TMDB discover.\n`);

  const results = { added: [], skipped: [], failed: [] };

  for (const candidate of candidates) {
    try {
      const detail = await getTmdbDetail(candidate.tmdbId, 'movie');
      const releaseYear = detail.releaseYear ? parseInt(detail.releaseYear) : null;

      // Filter out specials/shorts/interview content that streamers classify
      // as "movies" but aren't what this site means by one — TMDB's own
      // "TV Movie" genre tag catches most specials, and a runtime floor
      // catches short-form content (nature/sports "shorts", stand-up sets
      // filed without that genre tag).
      if (detail.genres.includes('TV Movie')) {
        console.log(`⚠ "${detail.title}" — TV Movie/special, skipping`);
        results.skipped.push(detail.title);
        await sleep(300);
        continue;
      }
      if (detail.runtime && detail.runtime < 60) {
        console.log(`⚠ "${detail.title}" — runtime ${detail.runtime}min, too short, skipping`);
        results.skipped.push(detail.title);
        await sleep(300);
        continue;
      }

      const duplicate = await findDuplicate({
        title: detail.title, mediaType: 'MOVIE', tmdbId: detail.tmdbId, releaseYear,
      });
      if (duplicate) {
        console.log(`⚠ "${detail.title}" — already in database (${duplicate.slug}), skipping`);
        results.skipped.push(detail.title);
        await sleep(300);
        continue;
      }

      if (dryRun) {
        console.log(`+ "${detail.title}" (${releaseYear || 'year unknown'}) — would be added`);
        results.added.push(detail.title);
        await sleep(300);
        continue;
      }

      const slug = await uniqueSlug(slugify(detail.title, releaseYear));
      const castData = await connectCast(detail.cast || []);
      await prisma.mediaItem.create({
        data: {
          mediaType: 'MOVIE',
          title: detail.title,
          slug,
          releaseYear,
          verified: true, // auto-publish — see file header comment
          description: detail.description || null,
          imageUrl: detail.imageUrl || null,
          genres: normalizeGenres(detail.genres || []),
          tmdbId: detail.tmdbId,
          tmdbRating: detail.tmdbRating || null,
          directors: await connectPersons(detail.directors || []),
          cast: castData.cast,
          castOrder: castData.castOrder,
        },
      });
      console.log(`✓ "${detail.title}" (${releaseYear || 'year unknown'}) — added`);
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
