// src/services/externalRatings.js
//
// Fetches ratings from OMDB (IMDB + Rotten Tomatoes), Google Books, and
// OpenCritic, then caches results on the MediaItem row.
//
// All keys are optional — the service is gracefully no-ops when a key
// or ID is absent.

const prisma = require('../lib/prisma');

// ─── Main entry point ────────────────────────────────────────────────────────
async function fetchExternalRatings(mediaItemId) {
  const item = await prisma.mediaItem.findUnique({ where: { id: mediaItemId } });
  if (!item) throw new Error('Media item not found');

  const updates = {};

  // OMDB — covers IMDB rating + Rotten Tomatoes for movies & shows
  if (item.imdbId && process.env.OMDB_API_KEY) {
    const omdb = await fetchOMDB(item.imdbId);
    if (omdb) Object.assign(updates, omdb);
  }

  // Google Books — for books
  if (item.goodreadsId && process.env.GOOGLE_BOOKS_API_KEY) {
    // Note: Goodreads API is closed; Google Books is the best public proxy
    const gb = await fetchGoogleBooks(item.goodreadsId);
    if (gb) Object.assign(updates, gb);
  }

  // OpenCritic — for video games
  if (item.openCriticId && process.env.OPENCRITC_API_KEY) {
    const oc = await fetchOpenCritic(item.openCriticId);
    if (oc) Object.assign(updates, oc);
  }

  if (Object.keys(updates).length === 0) return item;

  return prisma.mediaItem.update({
    where: { id: mediaItemId },
    data: { ...updates, externalRatingsUpdatedAt: new Date() },
  });
}

// ─── OMDB (IMDB + Rotten Tomatoes) ──────────────────────────────────────────
async function fetchOMDB(imdbId) {
  try {
    const url = `https://www.omdbapi.com/?i=${imdbId}&apikey=${process.env.OMDB_API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.Response === 'False') return null;

    const updates = {};

    // IMDB rating
    if (data.imdbRating && data.imdbRating !== 'N/A') {
      updates.imdbRating = parseFloat(data.imdbRating);
    }

    // Rotten Tomatoes — in Ratings array
    const rt = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
    if (rt) {
      updates.rtScore = parseInt(rt.Value); // "84%" → 84
    }

    // Metacritic
    if (data.Metascore && data.Metascore !== 'N/A') {
      updates.metacriticScore = parseInt(data.Metascore);
    }

    return Object.keys(updates).length ? updates : null;
  } catch (err) {
    console.warn(`[OMDB] Failed for ${imdbId}:`, err.message);
    return null;
  }
}

// ─── Google Books (goodreads proxy) ─────────────────────────────────────────
async function fetchGoogleBooks(volumeId) {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes/${volumeId}?key=${process.env.GOOGLE_BOOKS_API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.volumeInfo) return null;

    const updates = {};
    if (data.volumeInfo.averageRating) {
      updates.goodreadsRating = data.volumeInfo.averageRating; // 0–5
    }

    return Object.keys(updates).length ? updates : null;
  } catch (err) {
    console.warn(`[GoogleBooks] Failed for ${volumeId}:`, err.message);
    return null;
  }
}

// ─── OpenCritic ──────────────────────────────────────────────────────────────
async function fetchOpenCritic(gameId) {
  try {
    const url = `https://api.opencritic.com/api/game/${gameId}`;
    const res  = await fetch(url, {
      headers: { 'x-opencritic-api-key': process.env.OPENCRITC_API_KEY },
    });
    const data = await res.json();

    const updates = {};
    if (data.topCriticScore != null) {
      updates.openCriticScore = Math.round(data.topCriticScore);
    }

    return Object.keys(updates).length ? updates : null;
  } catch (err) {
    console.warn(`[OpenCritic] Failed for ${gameId}:`, err.message);
    return null;
  }
}

// ─── Batch refresh (run as a cron job) ──────────────────────────────────────
// Call this nightly to keep ratings fresh (max 1 request/sec to be polite)
async function refreshStaleRatings(olderThanDays = 7) {
  const since = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const stale = await prisma.mediaItem.findMany({
    where: {
      OR: [
        { externalRatingsUpdatedAt: null },
        { externalRatingsUpdatedAt: { lt: since } },
      ],
      OR: [
        { imdbId: { not: null } },
        { goodreadsId: { not: null } },
        { openCriticId: { not: null } },
      ],
    },
    select: { id: true },
    take: 100, // cap per run
  });

  console.log(`[Ratings Refresh] ${stale.length} items need updating`);
  for (const { id } of stale) {
    await fetchExternalRatings(id).catch(e => console.warn(e));
    await sleep(1100); // 1 req/sec
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { fetchExternalRatings, refreshStaleRatings };
