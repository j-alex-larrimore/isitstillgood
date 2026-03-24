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

async function refreshStaleRatings() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stale = await prisma.mediaItem.findMany({
    where: {
      externalRatingsUpdatedAt: { lt: sevenDaysAgo },
      OR: [{ tmdbId: { not: null } }, { openCriticId: { not: null } }],
    },
    select: { id: true },
    take: 50,
  });
  for (const item of stale) await fetchExternalRatings(item.id).catch(console.error);
}

module.exports = { fetchExternalRatings, refreshStaleRatings, fetchTmdbData, fetchIgdbData, fetchOpenLibraryData };
