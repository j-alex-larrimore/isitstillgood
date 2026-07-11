// Pilot / one-off: given a list of show titles, looks each up on TMDB,
// creates the parent show row (verified:false, review queue) plus one child
// row per season with that season's actual cast and excludedCast (parent's
// main cast minus that season's cast — departed/not-yet-joined actors).
// This is the season-population approach described for the full TV backfill,
// run here against a couple of known shows so it can be spot-checked in the
// admin review UI before running it at ~9,400-show scale.
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, normalizeGenres, findDuplicate } = require('../src/lib/mediaHelpers');
const { searchTmdb, getTmdbDetail } = require('../src/services/mediaLookup');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TITLES = process.argv.slice(2).length ? process.argv.slice(2) : ['Shrinking', 'The Closer'];

async function getSeasonCast(tmdbId, seasonNumber, token = process.env.TMDB_READ_ACCESS_TOKEN) {
  const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?append_to_response=credits`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    name: data.name,
    releaseYear: (data.air_date || '').split('-')[0] || null,
    cast: (data.credits?.cast || []).slice(0, 20).map(c => c.name),
  };
}

async function main() {
  for (const title of TITLES) {
    console.log(`\n=== ${title} ===`);
    const candidates = await searchTmdb(title, 'tv');
    const best = candidates.find(c => c.title.toLowerCase() === title.toLowerCase()) || candidates[0];
    if (!best) { console.log(`No TMDB match for "${title}"`); continue; }

    const detail = await getTmdbDetail(best.tmdbId, 'tv');
    const releaseYear = detail.releaseYear ? parseInt(detail.releaseYear) : null;

    const duplicate = await findDuplicate({ title: detail.title, mediaType: 'TV_SHOW', tmdbId: detail.tmdbId, releaseYear });
    if (duplicate) {
      console.log(`"${detail.title}" already in DB (${duplicate.slug}) — skipping`);
      continue;
    }

    const slug = await uniqueSlug(slugify(detail.title, releaseYear));
    const parent = await prisma.mediaItem.create({
      data: {
        mediaType: 'TV_SHOW',
        title: detail.title,
        slug,
        releaseYear,
        verified: false,
        description: detail.description || null,
        imageUrl: detail.imageUrl || null,
        genres: normalizeGenres(detail.genres || []),
        tmdbId: detail.tmdbId,
        tmdbRating: detail.tmdbRating || null,
        seasons: detail.seasons || null,
        directors: await connectPersons(detail.directors || []), // creators, per getTmdbDetail
        cast: await connectPersons(detail.cast || []),
      },
    });
    console.log(`Created parent "${parent.title}" (${releaseYear}), ${detail.seasons || 0} season(s) — ${parent.slug}`);

    const mainCastNames = new Set((detail.cast || []).map(n => n.toLowerCase()));

    for (let n = 1; n <= (detail.seasons || 0); n++) {
      await sleep(250);
      const season = await getSeasonCast(detail.tmdbId, n);
      if (!season) { console.log(`  Season ${n}: no data, skipping`); continue; }

      const excludedCast = (detail.cast || []).filter(name => !season.cast.some(c => c.toLowerCase() === name.toLowerCase()));
      // Season cast is guest stars only — main-cast members already show on
      // the parent, so repeating them here is redundant. Only list people
      // TMDB's season credits surface who aren't part of the main cast.
      const guestCast = season.cast.filter(name => !mainCastNames.has(name.toLowerCase()));
      const seasonSlug = await uniqueSlug(slugify(`${detail.title} Season ${n}`, season.releaseYear));

      await prisma.mediaItem.create({
        data: {
          mediaType: 'TV_SHOW',
          title: `${detail.title} — Season ${n}`,
          slug: seasonSlug,
          releaseYear: season.releaseYear ? parseInt(season.releaseYear) : null,
          verified: false,
          parentId: parent.id,
          seasonNumber: n,
          genres: normalizeGenres(detail.genres || []),
          excludedCast,
          cast: await connectPersons(guestCast),
        },
      });
      console.log(`  Season ${n} (${season.releaseYear || 'year unknown'}): ${guestCast.length} guest cast, ${excludedCast.length} excluded`);
    }
    await sleep(250);
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
