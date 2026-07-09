// src/services/mediaLookup.js — external metadata search/detail lookups.
// Shared by src/routes/admin.js (the admin UI's search-as-you-type forms)
// and scripts/bulk-import.js (the CLI importer) so both resolve titles
// against TMDB/Google Books/Open Library/IGDB identically.
const { getIgdbToken } = require('./externalRatings');

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
  const res = await fetch(
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
  const res = await fetch(
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
  };
}

// ─── Google Books ──────────────────────────────────────────────────────────────
async function searchGoogleBooks(q, author, year, apiKey = process.env.GOOGLE_BOOKS_API_KEY) {
  if (!apiKey) throw new Error('GOOGLE_BOOKS_API_KEY not configured');
  let query = `intitle:${q}`;
  if (author) query += `+inauthor:${author}`;

  let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20&printType=books&key=${apiKey}`;
  if (year) url += `&publishedDate:${year}`;

  const res = await fetch(url);
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
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes/${id}?key=${apiKey}`);
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
  const res = await fetch(searchUrl);
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
    fetch(`https://openlibrary.org/works/${id}.json`),
    fetch(`https://openlibrary.org/works/${id}/editions.json?limit=10`),
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

  const res = await fetch('https://api.igdb.com/v4/games', {
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
};
