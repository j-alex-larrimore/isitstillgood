// src/services/mediaLookup.js — external metadata search/detail lookups.
// Shared by src/routes/admin.js (the admin UI's search-as-you-type forms)
// and scripts/bulk-import.js (the CLI importer) so both resolve titles
// against TMDB/Google Books/Open Library/IGDB identically.
const { getIgdbToken } = require('./externalRatings');

// ─── Retry wrapper ─────────────────────────────────────────────────────────
// These APIs (Google Books especially) intermittently return transient 5xx
// errors under normal use. Retry a couple of times with backoff before
// giving up, but don't retry 4xx — those won't fix themselves.
async function fetchWithRetry(url, options, retries = 3, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status < 500 || attempt === retries) return res;
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
  }
}

// ─── Open Library genre filter ────────────────────────────────────────────────
// Open Library subjects are very noisy — they include things like
// "Protected DAISY", "In library", "Large type books", "Internet Archive Wishlist"
// alongside real genres. This filter strips non-genre entries and returns
// only clean, short, recognisable genre-like terms.
function filterOpenLibraryGenres(subjects) {
  const blocklist = [
    'in library', 'protected daisy', 'accessible book', 'internet archive',
    'large type', 'open library', 'overdrive', 'nglc', 'reading level',
    'homeschool', 'libraries', 'lending library', 'new york times',
    'bestseller', 'award', 'prize', 'banned', 'challenged', 'banned books',
    'juvenile', 'young adult fiction', 'children', 'daisy',
    'wishlist', 'favourites', 'favorites', 'to read', 'owned',
    'currently reading', 'read', 'unread',
  ];

  return subjects
    .filter(s => {
      if (!s || typeof s !== 'string') return false;
      const lower = s.toLowerCase();
      if (blocklist.some(b => lower.includes(b))) return false;
      if (s.length > 30) return false;
      if (/^\d/.test(s)) return false;
      if (s.includes('(') || s.includes(')')) return false;
      return true;
    })
    .slice(0, 5);
}

// ─── Clean book description ──────────────────────────────────────────────────
function cleanBookDescription(raw) {
  if (!raw) return null;

  let text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .trim();

  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  const marketingPatterns = [
    /bestseller/i,
    /new york times/i,
    /wall street journal/i,
    /named.*best/i,
    /one of.*favorite/i,
    /from the.*(?:bestselling )?author of/i,
    /^["“]/,
    /^—/,
    /•.*•/,
  ];

  let descStart = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    if (!marketingPatterns.some(p => p.test(paragraphs[i]))) { descStart = i; break; }
    descStart = i + 1;
  }

  const cleaned = paragraphs.slice(descStart).join('\n\n') || text;
  return cleaned.slice(0, 3000).trim();
}

// ─── TMDB — movies and TV shows ───────────────────────────────────────────────
async function searchTmdb(q, type = 'movie', year, token = process.env.TMDB_READ_ACCESS_TOKEN) {
  if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN not configured');
  const endpoint = type === 'tv' ? 'tv' : 'movie';
  const yearParam = year ? `&${type === 'tv' ? 'first_air_date_year' : 'year'}=${year}` : '';
  const res = await fetchWithRetry(
    `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(q)}&include_adult=false${yearParam}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('TMDB search failed');
  const data = await res.json();
  return (data.results || []).slice(0, 15).map(item => ({
    tmdbId:      String(item.id),
    title:       item.title || item.name,
    releaseYear: (item.release_date || item.first_air_date || '').split('-')[0],
    overview:    item.overview,
    posterUrl:   item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    rating:      item.vote_average,
  }));
}

async function getTmdbDetail(id, type = 'movie', token = process.env.TMDB_READ_ACCESS_TOKEN) {
  if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN not configured');
  const endpoint = type === 'tv' ? 'tv' : 'movie';
  const res = await fetchWithRetry(
    `https://api.themoviedb.org/3/${endpoint}/${id}?append_to_response=credits`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('TMDB detail fetch failed');
  const data = await res.json();

  const directors = (data.credits?.crew || []).filter(p => p.job === 'Director').map(p => p.name);
  const cast = (data.credits?.cast || []).slice(0, 20).map(p => p.name);
  const creators = (data.created_by || []).map(p => p.name);

  return {
    tmdbId:      String(data.id),
    title:       data.title || data.name,
    releaseYear: (data.release_date || data.first_air_date || '').split('-')[0],
    description: data.overview,
    imageUrl:    data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
    genres:      (data.genres || []).map(g => g.name),
    directors:   directors.length ? directors : creators,
    cast,
    seasons:     data.number_of_seasons || null,
    tmdbRating:  data.vote_average || null,
    runtime:     data.runtime || null, // movies only — used by sync-new-releases.js to filter out specials/shorts
  };
}

// Real (non-special) season numbers currently on TMDB for a show — used by
// scripts/sync-new-seasons.js to detect seasons that exist on TMDB but not
// yet as a MediaItem row. Season 0 (specials) is excluded; this site doesn't
// model specials as their own reviewable season.
async function getTvSeasonNumbers(id, token = process.env.TMDB_READ_ACCESS_TOKEN) {
  if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN not configured');
  const res = await fetchWithRetry(`https://api.themoviedb.org/3/tv/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('TMDB TV detail fetch failed');
  const data = await res.json();
  return {
    seasonNumbers: (data.seasons || []).filter(s => s.season_number > 0).map(s => s.season_number),
    totalSeasons: data.number_of_seasons || 0,
  };
}

// A single season's cast — used by every script that creates TV season rows
// (scripts/import-tv-show-with-seasons.js, import-missing-tv.js,
// sync-new-tv.js, sync-new-seasons.js). Season "cast" on this site means
// guest stars only (main-cast members are filtered out by the caller before
// storing) — see the excludedCast field comment in prisma/schema.prisma.
async function getTvSeasonCast(id, seasonNumber, token = process.env.TMDB_READ_ACCESS_TOKEN) {
  if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN not configured');
  const res = await fetchWithRetry(`https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}?append_to_response=credits`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    releaseYear: (data.air_date || '').split('-')[0] || null,
    cast: (data.credits?.cast || []).slice(0, 20).map(c => c.name),
  };
}

// TMDB per-show keyword data — used by the setting-genre heuristic
// (Schools/Police/Legal/Courtroom/Medical) in apply-setting-genres-tv.js,
// import-missing-tv.js, and sync-new-tv.js/sync-new-seasons.js.
async function getTvKeywords(id, token = process.env.TMDB_READ_ACCESS_TOKEN) {
  if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN not configured');
  const res = await fetchWithRetry(`https://api.themoviedb.org/3/tv/${id}/keywords`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map(k => k.name.toLowerCase());
}

// ─── Google Books ──────────────────────────────────────────────────────────────
async function searchGoogleBooks(q, author, year, apiKey = process.env.GOOGLE_BOOKS_API_KEY) {
  if (!apiKey) throw new Error('GOOGLE_BOOKS_API_KEY not configured');
  let query = `intitle:${q}`;
  if (author) query += `+inauthor:${author}`;

  let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20&printType=books&key=${apiKey}`;
  if (year) url += `&publishedDate:${year}`;

  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error('Google Books search failed');
  const data = await res.json();

  const results = (data.items || []).slice(0, 15).map(item => {
    const info = item.volumeInfo || {};
    return {
      googleBooksId: item.id,
      title:         info.title || '',
      authors:       info.authors || [],
      releaseYear:   info.publishedDate ? parseInt(info.publishedDate) : null,
      description:   cleanBookDescription(info.description),
      imageUrl:      info.imageLinks?.thumbnail?.replace('http://', 'https://').replace('zoom=1', 'zoom=3') || null,
      genres:        (info.categories || []).slice(0, 5),
      pageCount:     info.pageCount || null,
      isbn:          (info.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier || null,
    };
  });

  return results.filter(r => r.title);
}

async function getGoogleBooksDetail(id, apiKey = process.env.GOOGLE_BOOKS_API_KEY) {
  if (!apiKey) throw new Error('GOOGLE_BOOKS_API_KEY not configured');
  const res = await fetchWithRetry(`https://www.googleapis.com/books/v1/volumes/${id}?key=${apiKey}`);
  if (!res.ok) throw new Error('Google Books fetch failed');
  const item = await res.json();
  const info = item.volumeInfo || {};

  const genres = (info.categories || [])
    .flatMap(c => c.split('/').map(s => s.trim()))
    .filter(g => g && g.length < 30)
    .slice(0, 5);

  return {
    googleBooksId: item.id,
    title:         info.title,
    authors:       info.authors || [],
    releaseYear:   info.publishedDate ? parseInt(info.publishedDate) : null,
    description:   cleanBookDescription(info.description),
    imageUrl:      info.imageLinks?.thumbnail?.replace('http://', 'https://').replace('zoom=1', 'zoom=3') || null,
    genres,
    isbn:          (info.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier || null,
  };
}

// ─── Open Library — book fallback when Google Books has no key/results ────────
async function searchOpenLibrary(q, year, author) {
  let searchUrl = `https://openlibrary.org/search.json?title=${encodeURIComponent(q)}&limit=20&fields=key,title,author_name,first_publish_year,cover_i,subject`;
  if (author) searchUrl += `&author=${encodeURIComponent(author)}`;
  if (year)   searchUrl += `&first_publish_year=${encodeURIComponent(year)}`;
  const res = await fetchWithRetry(searchUrl);
  if (!res.ok) throw new Error('Open Library search failed');
  const data = await res.json();

  return (data.docs || []).slice(0, 15).map(item => ({
    openLibraryId: item.key?.replace('/works/', ''),
    title:         item.title,
    authors:       item.author_name || [],
    releaseYear:   item.first_publish_year || null,
    imageUrl:      item.cover_i ? `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg` : null,
    genres:        filterOpenLibraryGenres(item.subject || []),
  }));
}

async function getOpenLibraryDetail(id, year) {
  const [workRes, editionsRes] = await Promise.all([
    fetchWithRetry(`https://openlibrary.org/works/${id}.json`),
    fetchWithRetry(`https://openlibrary.org/works/${id}/editions.json?limit=10`),
  ]);
  if (!workRes.ok) throw new Error('Open Library fetch failed');
  const data     = await workRes.json();
  const editions = editionsRes.ok ? await editionsRes.json() : null;

  const authorIds = (data.authors || []).map(a => a.author?.key).filter(Boolean);
  const authorNames = await Promise.all(
    authorIds.slice(0, 3).map(async key => {
      try {
        const r = await fetch(`https://openlibrary.org${key}.json`);
        const d = await r.json();
        return d.name || null;
      } catch { return null; }
    })
  );

  const description = typeof data.description === 'string'
    ? data.description
    : data.description?.value || '';

  let coverId = data.covers?.[0] || null;
  if (!coverId && editions?.entries?.length) {
    for (const edition of editions.entries) {
      if (edition.covers?.[0]) { coverId = edition.covers[0]; break; }
    }
  }

  let releaseYear = year ? parseInt(year) : null;
  if (!releaseYear && data.first_publish_date) {
    const match = String(data.first_publish_date).match(/\d{4}/);
    if (match) releaseYear = parseInt(match[0]);
  }
  if (!releaseYear && editions?.entries?.length) {
    const years = editions.entries
      .map(e => {
        const m = String(e.publish_date || '').match(/\d{4}/);
        return m ? parseInt(m[0]) : null;
      })
      .filter(y => y && y > 1000 && y < 2100);
    if (years.length) releaseYear = Math.min(...years);
  }

  return {
    openLibraryId: id,
    title:         data.title,
    description:   description.slice(0, 3000),
    authors:       authorNames.filter(Boolean),
    releaseYear,
    imageUrl:      coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
    genres:        filterOpenLibraryGenres(data.subjects || []),
  };
}

// ─── IGDB — video games ─────────────────────────────────────────────────────
async function searchIgdb(q, year, clientId = process.env.IGDB_CLIENT_ID, clientSecret = process.env.IGDB_CLIENT_SECRET) {
  if (!clientId || !clientSecret) throw new Error('IGDB_CLIENT_ID and IGDB_CLIENT_SECRET not configured');
  const token = await getIgdbToken();
  if (!token) throw new Error('IGDB auth failed');

  const res = await fetchWithRetry('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID':     clientId,
      Authorization:   `Bearer ${token}`,
      'Content-Type':  'text/plain',
    },
    body: `search "${q}"; fields name,cover.url,first_release_date,genres.name,involved_companies.company.name,summary,rating; limit 15;`,
  });
  if (!res.ok) throw new Error('IGDB search failed');
  let games = await res.json();

  if (year) {
    const filterYear = parseInt(year);
    games = games.filter(g => {
      if (!g.first_release_date) return false;
      return new Date(g.first_release_date * 1000).getFullYear() === filterYear;
    });
  }

  return games.map(game => ({
    igdbId:      String(game.id),
    title:       game.name,
    releaseYear: game.first_release_date ? new Date(game.first_release_date * 1000).getFullYear() : null,
    description: game.summary || null,
    imageUrl:    game.cover?.url ? 'https:' + game.cover.url.replace('t_thumb', 't_cover_big') : null,
    genres:      (game.genres || []).map(g => g.name),
    developers:  (game.involved_companies || []).map(c => c.company?.name).filter(Boolean),
    rating:      game.rating ? Math.round(game.rating) : null,
  }));
}

// ─── TMDB discovery — used by scripts/sync-new-releases.js ────────────────
// Unlike searchTmdb (title lookup for a known movie), this finds NEW movies
// matching filters (release window + major studio/streamer) without a title
// to search for. Resolves human-readable provider/company names to TMDB's
// numeric IDs at call time rather than hardcoding IDs, since those aren't
// documented anywhere stable enough to trust from memory.
async function resolveWatchProviderIds(names, region = 'US', mediaKind = 'movie', token = process.env.TMDB_READ_ACCESS_TOKEN) {
  const res = await fetchWithRetry(
    `https://api.themoviedb.org/3/watch/providers/${mediaKind}?watch_region=${region}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('TMDB watch-provider list fetch failed');
  const data = await res.json();
  const lowerNames = names.map(n => n.toLowerCase());
  return (data.results || [])
    .filter(p => lowerNames.includes(p.provider_name.toLowerCase()))
    .map(p => p.provider_id);
}

// Resolves TV genre names (e.g. "News", "Talk") to TMDB's numeric genre IDs
// at call time — same reasoning as the provider/company resolvers above,
// don't trust hardcoded genre IDs from memory.
async function resolveTvGenreIds(names, token = process.env.TMDB_READ_ACCESS_TOKEN) {
  const res = await fetchWithRetry('https://api.themoviedb.org/3/genre/tv/list', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('TMDB TV genre list fetch failed');
  const data = await res.json();
  const lowerNames = names.map(n => n.toLowerCase());
  return (data.genres || []).filter(g => lowerNames.includes(g.name.toLowerCase())).map(g => g.id);
}

async function resolveCompanyIds(names, token = process.env.TMDB_READ_ACCESS_TOKEN) {
  const ids = [];
  for (const name of names) {
    const res = await fetchWithRetry(
      `https://api.themoviedb.org/3/search/company?query=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) continue;
    const data = await res.json();
    // exact (case-insensitive) name match only — avoid pulling in unrelated
    // companies that merely contain the search term
    const exact = (data.results || []).find(c => c.name.toLowerCase() === name.toLowerCase());
    if (exact) ids.push(exact.id);
  }
  return ids;
}

// Discover movies released in [sinceDate, untilDate] (YYYY-MM-DD) from the
// given studios (with_companies, OR'd) or now available on the given
// streaming services (with_watch_providers, OR'd). Two separate discover
// calls combined, since a brand-new theatrical release often has no watch
// provider listed yet, and a streaming original has no notable "studio".
async function discoverNewMovies({ sinceDate, untilDate, studioNames = [], providerNames = [], region = 'US', token = process.env.TMDB_READ_ACCESS_TOKEN }) {
  if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN not configured');
  const results = new Map(); // tmdbId -> result, dedupes across both queries

  async function runDiscover(extraParams) {
    let page = 1, totalPages = 1;
    do {
      const url = `https://api.themoviedb.org/3/discover/movie?primary_release_date.gte=${sinceDate}&primary_release_date.lte=${untilDate}&region=${region}&page=${page}&${extraParams}`;
      const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('TMDB discover failed');
      const data = await res.json();
      totalPages = data.total_pages || 1;
      for (const item of data.results || []) {
        results.set(String(item.id), {
          tmdbId: String(item.id),
          title: item.title,
          releaseYear: (item.release_date || '').split('-')[0],
        });
      }
      page++;
    } while (page <= totalPages && page <= 25); // sane upper bound
  }

  if (studioNames.length) {
    const companyIds = await resolveCompanyIds(studioNames, token);
    if (companyIds.length) await runDiscover(`with_companies=${companyIds.join('|')}`);
  }
  if (providerNames.length) {
    const providerIds = await resolveWatchProviderIds(providerNames, region, 'movie', token);
    if (providerIds.length) await runDiscover(`with_watch_providers=${providerIds.join('|')}&watch_region=${region}`);
  }

  return [...results.values()];
}

// Discover TV shows first aired in [sinceDate, untilDate] from the given
// networks (with_networks — IDs must be pre-resolved, TMDB has no reliable
// name-to-ID search for networks, unlike movie companies) or streaming
// services (with_watch_providers). Excludes News/Talk genres by default.
async function discoverNewTvShows({ sinceDate, untilDate, networkIds = [], providerNames = [], region = 'US', excludeGenreNames = ['News', 'Talk', 'Reality'], token = process.env.TMDB_READ_ACCESS_TOKEN }) {
  if (!token) throw new Error('TMDB_READ_ACCESS_TOKEN not configured');
  const results = new Map();
  const excludeIds = excludeGenreNames.length ? await resolveTvGenreIds(excludeGenreNames, token) : [];
  const withoutGenres = excludeIds.length ? `&without_genres=${excludeIds.join(',')}` : '';

  async function runDiscover(extraParams) {
    let page = 1, totalPages = 1;
    do {
      const url = `https://api.themoviedb.org/3/discover/tv?first_air_date.gte=${sinceDate}&first_air_date.lte=${untilDate}&page=${page}${withoutGenres}&${extraParams}`;
      const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('TMDB TV discover failed');
      const data = await res.json();
      totalPages = data.total_pages || 1;
      for (const item of data.results || []) {
        results.set(String(item.id), {
          tmdbId: String(item.id),
          title: item.name,
          releaseYear: (item.first_air_date || '').split('-')[0],
        });
      }
      page++;
    } while (page <= totalPages && page <= 25);
  }

  if (networkIds.length) await runDiscover(`with_networks=${networkIds.join('|')}`);
  if (providerNames.length) {
    const providerIds = await resolveWatchProviderIds(providerNames, region, 'tv', token);
    if (providerIds.length) await runDiscover(`with_watch_providers=${providerIds.join('|')}&watch_region=${region}`);
  }

  return [...results.values()];
}

module.exports = {
  filterOpenLibraryGenres,
  cleanBookDescription,
  searchTmdb,
  getTmdbDetail,
  searchGoogleBooks,
  getGoogleBooksDetail,
  searchOpenLibrary,
  getOpenLibraryDetail,
  searchIgdb,
  discoverNewMovies,
  discoverNewTvShows,
  resolveTvGenreIds,
  getTvSeasonNumbers,
  getTvSeasonCast,
  getTvKeywords,
};
