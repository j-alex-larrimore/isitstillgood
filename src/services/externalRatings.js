// src/services/externalRatings.js
//
// Fetches external data for media items from licensed sources:
//   - TMDB        — movies and TV shows (cover art, ratings, cast, genres)
//   - Open Library — books (cover art, author, synopsis)
//   - IGDB        — video games (cover art, release date, genres)
//
// IMDb and Rotten Tomatoes removed due to licensing concerns.

const prisma = require('../lib/prisma');

// ─── TMDB ─────────────────────────────────────────────────────────────────────
// Uses the TMDB Read Access Token (Bearer token).
// Set TMDB_READ_ACCESS_TOKEN in Railway Variables.
async function fetchTmdbData(tmdbId, mediaType) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token || !tmdbId) return null;
  try {
    const endpoint = mediaType === 'TV_SHOW' ? 'tv' : 'movie';
    const res = await fetch(
      `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?append_to_response=credits`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) { console.error('TMDB fetch error:', err.message); return null; }
}

// ─── IGDB ─────────────────────────────────────────────────────────────────────
// Requires Twitch OAuth. Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET in Railway.
let igdbToken = null;
let igdbTokenExpiry = 0;

async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpiry - 300000) return igdbToken;
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const res = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      { method: 'POST' }
    );
    if (!res.ok) return null;
    const data = await res.json();
    igdbToken = data.access_token;
    igdbTokenExpiry = Date.now() + (data.expires_in * 1000);
    return igdbToken;
  } catch (err) { console.error('IGDB token error:', err.message); return null; }
}

async function fetchIgdbData(igdbId) {
  const token = await getIgdbToken();
  const clientId = process.env.IGDB_CLIENT_ID;
  if (!token || !clientId || !igdbId) return null;
  try {
    const res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: `fields name,cover.url,first_release_date,genres.name,involved_companies.company.name,summary,rating; where id = ${igdbId};`,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[0] || null;
  } catch (err) { console.error('IGDB fetch error:', err.message); return null; }
}

// ─── Open Library ─────────────────────────────────────────────────────────────
// No API key needed. Free including commercial use.
async function fetchOpenLibraryData(openLibraryId) {
  if (!openLibraryId) return null;
  try {
    const isIsbn = /^\d{10,13}$/.test(openLibraryId);
    const url = isIsbn
      ? `https://openlibrary.org/api/books?bibkeys=ISBN:${openLibraryId}&format=json&jscmd=data`
      : `https://openlibrary.org/works/${openLibraryId}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) { console.error('Open Library fetch error:', err.message); return null; }
}

// ─── Main sync ────────────────────────────────────────────────────────────────
async function fetchExternalRatings(mediaItemId) {
  const item = await prisma.mediaItem.findUnique({ where: { id: mediaItemId } });
  if (!item) return null;
  const updates = {};

  if ((item.mediaType === 'MOVIE' || item.mediaType === 'TV_SHOW') && item.tmdbId) {
    const data = await fetchTmdbData(item.tmdbId, item.mediaType);
    if (data?.vote_average) {
      updates.tmdbRating = data.vote_average;
      updates.externalRatingsUpdatedAt = new Date();
    }
  }

  if (item.mediaType === 'VIDEO_GAME' && item.openCriticId) {
    const data = await fetchIgdbData(item.openCriticId);
    if (data?.rating) {
      updates.openCriticScore = Math.round(data.rating);
      updates.externalRatingsUpdatedAt = new Date();
    }
  }

  if (Object.keys(updates).length) {
    return prisma.mediaItem.update({ where: { id: mediaItemId }, data: updates });
  }
  return item;
}

/* Refreshes the oldest external ratings, never-refreshed ones first.
 *
 * Three things were wrong with this before, and the first is why 40,141 of
 * the 42,190 refreshable items had never been touched:
 *
 *   1. `externalRatingsUpdatedAt: { lt: cutoff }` never matches NULL — in SQL
 *      NULL < anything is unknown, not true. So the query could only ever
 *      revisit rows that had already been refreshed at least once, and an
 *      item that had never been synced was permanently invisible to it.
 *   2. take: 50 with no caller and no schedule. Nothing imported this
 *      function at all; the only writes came from the per-item
 *      POST /api/media/:id/sync-ratings, pressed by hand.
 *   3. No pacing. IGDB allows about 4 requests a second and will start
 *      refusing beyond that, so an unthrottled loop fails most of its calls
 *      and looks like a data problem.
 *
 * Books are deliberately absent: no book carries tmdbId or openCriticId, and
 * fetchExternalRatings has no book branch, so there is nothing to refresh
 * yet. fetchOpenLibraryData exists but is not wired to anything.
 */
async function refreshStaleRatings({
  limit = 200,
  olderThanDays = 7,
  mediaTypes = null,
  delayMs = 250,          // ~4/sec, IGDB's documented ceiling
  dryRun = false,
  onProgress = null,
} = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const where = {
    AND: [
      { OR: [{ tmdbId: { not: null } }, { openCriticId: { not: null } }] },
      { OR: [{ externalRatingsUpdatedAt: null }, { externalRatingsUpdatedAt: { lt: cutoff } }] },
    ],
  };
  if (mediaTypes && mediaTypes.length) where.mediaType = { in: mediaTypes };

  const due = await prisma.mediaItem.count({ where });
  const batch = await prisma.mediaItem.findMany({
    where,
    select: { id: true, title: true, mediaType: true, externalRatingsUpdatedAt: true },
    // Never-refreshed first, then oldest. Without nulls:'first' the backlog
    // would stay at the back of the queue indefinitely.
    orderBy: { externalRatingsUpdatedAt: { sort: 'asc', nulls: 'first' } },
    take: limit,
  });

  const stats = { due, attempted: batch.length, updated: 0, unchanged: 0, failed: 0, dryRun };
  if (dryRun) return { ...stats, sample: batch.slice(0, 10) };

  for (const item of batch) {
    try {
      const before = item.externalRatingsUpdatedAt;
      const after = await fetchExternalRatings(item.id);
      // fetchExternalRatings returns the row untouched when the provider gave
      // it nothing usable, so compare rather than assume success.
      if (after && String(after.externalRatingsUpdatedAt) !== String(before)) stats.updated++;
      else stats.unchanged++;
    } catch (err) {
      stats.failed++;
      if (onProgress) onProgress({ item, error: err });
    }
    if (onProgress) onProgress({ item, stats });
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  return stats;
}

module.exports = { fetchExternalRatings, refreshStaleRatings, fetchTmdbData, fetchIgdbData, fetchOpenLibraryData, getIgdbToken };
