// scripts/backfill-tv-seasons.js
//
// Creates the per-season MediaItem rows for TV parents that don't have any.
// bulk-import.js only ever writes the parent show (its header says so), but
// TV reviews are written per season (see CLAUDE.md's data-model notes), so a
// parent with no season rows is a show nobody can review season-by-season.
//
//   node scripts/backfill-tv-seasons.js [--dry-run] [--limit=N] [--unverified-only]
//
// Dry run first, as with bulk-import.
//
// Follows the same shape sync-new-tv.js uses for seasons: one row per season
// with parentId set and seasonNumber filled in, title "<Show> — Season N",
// cast connected through connectCast so billing order survives. Specials
// (season_number 0) are skipped — they're not a viewing unit people review.
//
// Safe to re-run: a parent that already has a row for a given season number
// is left alone, so an interrupted run just resumes.

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectCast, normalizeGenres } = require('../src/lib/mediaHelpers');

const DRY = process.argv.includes('--dry-run');
const UNVERIFIED_ONLY = process.argv.includes('--unverified-only');
const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tmdb(path) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://api.themoviedb.org/3${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    });
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep(2000); continue; }
    if (r.status === 404) return null;
    throw new Error(`TMDB ${r.status} on ${path}`);
  }
  return null;
}

async function main() {
  if (!TOKEN) throw new Error('TMDB_READ_ACCESS_TOKEN missing from .env');

  // Parents with zero children. `seasons` (the total-count column) isn't
  // trusted here — the child rows are what the site actually reads.
  const parents = await prisma.mediaItem.findMany({
    where: {
      mediaType: 'TV_SHOW',
      parentId: null,
      tmdbId: { not: null },
      ...(UNVERIFIED_ONLY ? { verified: false } : {}),
      // seasonEntries is the reverse of the ShowSeasons self-relation (see
      // schema.prisma) — "no season rows exist for this parent".
      seasonEntries: { none: {} },
    },
    select: { id: true, title: true, tmdbId: true, verified: true },
    orderBy: { createdAt: 'desc' },
  });

  const targets = parents.slice(0, LIMIT);
  console.log(`${parents.length} TV parent(s) with no season rows; processing ${targets.length}${DRY ? ' (dry run — no writes)' : ''}\n`);

  let created = 0, shows = 0, failed = 0;
  for (const show of targets) {
    let detail;
    try {
      detail = await tmdb(`/tv/${show.tmdbId}?language=en-US`);
    } catch (err) {
      console.error(`  ✗ ${show.title}: ${err.message}`); failed++; await sleep(120); continue;
    }
    if (!detail || !Array.isArray(detail.seasons)) {
      console.log(`  ~ ${show.title}: no season data`); await sleep(120); continue;
    }

    const seasons = detail.seasons.filter(s => s.season_number > 0);
    if (!seasons.length) { console.log(`  ~ ${show.title}: no numbered seasons`); await sleep(120); continue; }

    console.log(`  ${show.title} — ${seasons.length} season(s)`);
    shows++;

    for (const s of seasons) {
      if (DRY) { created++; continue; }
      try {
        const sd = await tmdb(`/tv/${show.tmdbId}/season/${s.season_number}?language=en-US`);
        const title = `${show.title} — Season ${s.season_number}`;
        const cast = (sd?.credits?.cast || detail.credits?.cast || []).slice(0, 20).map(c => c.name);
        const castRel = cast.length ? await connectCast(cast, false) : null;

        await prisma.mediaItem.create({
          data: {
            mediaType: 'TV_SHOW',
            title,
            slug: await uniqueSlug(slugify(title)),
            parentId: show.id,
            seasonNumber: s.season_number,
            releaseYear: s.air_date ? parseInt(s.air_date.slice(0, 4)) : null,
            description: s.overview || detail.overview || null,
            imageUrl: s.poster_path
              ? `https://image.tmdb.org/t/p/w500${s.poster_path}`
              : (detail.poster_path ? `https://image.tmdb.org/t/p/w500${detail.poster_path}` : null),
            genres: normalizeGenres((detail.genres || []).map(g => g.name)),
            tmdbId: String(detail.id),
            // Seasons inherit the parent's review state: approving a show
            // shouldn't leave its seasons stuck in the queue behind it.
            verified: show.verified,
            ...(castRel || {}),
          },
        });
        created++;
      } catch (err) {
        console.error(`    ✗ season ${s.season_number}: ${err.message}`);
        failed++;
      }
      await sleep(110);
    }
    await sleep(110);
  }

  console.log(`\n${DRY ? 'Would create' : 'Created'} ${created} season row(s) across ${shows} show(s). Failed: ${failed}.`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
