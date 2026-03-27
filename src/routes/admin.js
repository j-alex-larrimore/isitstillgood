// src/routes/admin.js
const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const prisma  = require('../lib/prisma');
const { requireAdmin } = require('../middleware/admin');
const { fetchExternalRatings } = require('../services/externalRatings');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

function slugify(title, year) {
  const base = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
  return year ? `${base}-${year}` : base;
}

async function uniqueSlug(base) {
  let slug = base, i = 1;
  while (await prisma.mediaItem.findUnique({ where: { slug } })) slug = `${base}-${i++}`;
  return slug;
}

// connectPersons builds the Prisma relation payload for cast/directors/authors.
// isUpdate=true  → uses {set:[...]} which replaces the full relation (correct for PATCH)
// isUpdate=false → uses {connect:[...]} which adds relations (correct for CREATE)
// Empty names + isUpdate → {set:[]} removes all; empty + create → undefined (skip field)
async function connectPersons(names, isUpdate = false) {
  if (!names?.length) {
    // On update, empty array means "remove all relations"
    // On create, skip the field entirely (no relations to set up)
    return isUpdate ? { set: [] } : undefined;
  }

  const persons = await Promise.all(names.map(name => {
    const personSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return prisma.person.upsert({
      where: { slug: personSlug },
      update: { name },
      create: { name, slug: personSlug },
    });
  }));

  const ids = persons.map(p => ({ id: p.id }));
  // set: replaces the entire relation (update) — removes anyone not in the new list
  // connect: adds to existing relations (create) — only adds, never removes
  return isUpdate ? { set: ids } : { connect: ids };
}

// ─── GET /api/admin/stats ─────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const [users, mediaItems, reviews, pendingRequests] = await Promise.all([
      prisma.user.count(),
      prisma.mediaItem.count(),
      prisma.review.count(),
      prisma.mediaRequest.count({ where: { resolved: false, flagged: false } }),
    ]);
    res.json({ users, mediaItems, reviews, pendingRequests });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/requests ──────────────────────────────────────────────
router.get('/requests', requireAdmin, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = 50;
    const resolved = req.query.resolved === 'true';
    const [requests, total] = await Promise.all([
      prisma.mediaRequest.findMany({
        where: { resolved },
        include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
        orderBy: [{ requestCount: 'desc' }, { createdAt: 'asc' }],
        skip: (page - 1) * take, take,
      }),
      prisma.mediaRequest.count({ where: { resolved } }),
    ]);
    res.json({ requests, total, page, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/requests/:id/flag ──────────────────────────────────
router.patch('/requests/:id/flag', requireAdmin, [
  body('flagNote').trim().isLength({ min: 1, max: 500 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const request = await prisma.mediaRequest.update({
      where: { id: req.params.id },
      data: { flagged: true, flagNote: req.body.flagNote },
    });
    await prisma.notification.create({
      data: {
        userId: request.userId, type: 'REQUEST_FLAGGED',
        payload: { requestId: request.id, title: request.title, flagNote: req.body.flagNote },
      },
    }).catch(console.error);
    res.json(request);
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/requests/:id/resolve ───────────────────────────────
router.patch('/requests/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const request = await prisma.mediaRequest.update({ where: { id: req.params.id }, data: { resolved: true } });
    res.json(request);
  } catch (err) { next(err); }
});

// ─── DELETE /api/admin/requests/:id ──────────────────────────────────────
router.delete('/requests/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.mediaRequest.delete({ where: { id: req.params.id } });
    res.json({ message: 'Request deleted' });
  } catch (err) { next(err); }
});

// ─── POST /api/admin/media ─── Add a media item ───────────────────────────
router.post('/media', requireAdmin, [
  body('mediaType').isIn(['MOVIE', 'BOOK', 'TV_SHOW', 'VIDEO_GAME']),
  body('title').trim().notEmpty(),
  body('releaseYear').optional({ nullable: true }).isInt({ min: 1800, max: 2200 }),
  body('description').optional().trim(),
  body('imageUrl').optional({ nullable: true }),
  body('genres').optional().isArray(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const {
      mediaType, title, releaseYear, description, imageUrl, genres,
      tmdbId, goodreadsId, openCriticId, tags, excludedCast,
      // Movie
      directorNames, castNames,
      // TV Show — parent show fields (seasons = total count on parent row)
      seasons,
      // TV Season — used when adding a season linked to a parent show
      parentId,        // ID of the parent show MediaItem row
      seasonNumber,    // which season this entry represents (1, 2, 3…)

      // Book
      authorNames, seriesName, seriesNumber,
      // Video game
      openCriticId: ocId,
    } = req.body;

    // Auto-build title for TV seasons ("Show — Season N") and book entries ("Series — Book N")
    let finalTitle = title;
    if (parentId && (seasonNumber || seriesNumber)) {
      const parentItem = await prisma.mediaItem.findUnique({
        where: { id: parentId },
        select: { title: true },
      });
      if (parentItem) {
        if (mediaType === 'TV_SHOW' && seasonNumber && !title.toLowerCase().includes('season')) {
          finalTitle = `${parentItem.title} — Season ${seasonNumber}`;
        } else if (mediaType === 'BOOK' && seriesNumber && !title.toLowerCase().includes('book')) {
          finalTitle = title || `${parentItem.title} — Book ${seriesNumber}`;
        }
      }
    }

    const slug = await uniqueSlug(slugify(finalTitle, releaseYear));

    const item = await prisma.mediaItem.create({
      data: {
        mediaType,
        title: finalTitle,
        slug,
        releaseYear: releaseYear ? parseInt(releaseYear) : null,
        description:     description || null,
        imageUrl:        imageUrl    || null,
        genres:          genres      || [],
        // Tags — franchise, studio, network etc. e.g. "Marvel", "HBO", "Star Wars"
        tags:            (tags || []).map(t => t.trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')),
        excludedCast:    excludedCast || [],  // cast members who left before this season
        tmdbId:          tmdbId      || null,
        goodreadsId:     goodreadsId || null,
        openCriticId:    openCriticId || ocId || null,

        // TV parent show — total season count
        seasons:         seasons     ? parseInt(seasons)      : null,
        // TV season — link to parent and record season number
        parentId:        parentId    || null,
        seasonNumber:    seasonNumber ? parseInt(seasonNumber) : null,

        // Book
        seriesName:      seriesName  || null,
        seriesNumber:    seriesNumber ? parseInt(seriesNumber) : null,
        // Person relations
        directors: await connectPersons(directorNames),
        cast:      await connectPersons(castNames),
        authors:   await connectPersons(authorNames),
      },
      include: { directors: true, cast: true, authors: true },
    });

    if (tmdbId || goodreadsId || openCriticId) {
      fetchExternalRatings(item.id).catch(console.error);
    }

    res.status(201).json(item);
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/media/:id ───────────────────────────────────────────
router.patch('/media/:id', requireAdmin, async (req, res, next) => {
  try {
    // Scalar fields — updated directly
    const allowed = [
      'title','description','imageUrl','genres','releaseYear',
      'tmdbId','tmdbRating','tags','excludedCast',
      'goodreadsId','openCriticId','openCriticScore',
      'seasons','seriesName','seriesNumber',
    ];
    const data = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    // Relation fields — cast, directors, authors are many-to-many through Person.
    // They need the { set: [...] } Prisma relation syntax, not direct assignment.
    // We accept comma-separated name strings and upsert Person records as needed.
    // An empty array clears the relation entirely (allows removing all cast).
    const { castNames, directorNames, authorNames } = req.body;

    // Pass isUpdate=true so connectPersons uses {set:[...]} to fully replace relations
    if (castNames !== undefined) {
      data.cast = await connectPersons(castNames, true);
    }
    if (directorNames !== undefined) {
      data.directors = await connectPersons(directorNames, true);
    }
    if (authorNames !== undefined) {
      data.authors = await connectPersons(authorNames, true);
    }

    const item = await prisma.mediaItem.update({
      where: { id: req.params.id },
      data,
      include: {
        cast:      { select: { id: true, name: true }, take: 100 },
        directors: { select: { id: true, name: true }, take: 100 },
        authors:   { select: { id: true, name: true }, take: 100 },
      },
    });
    // Sort people alphabetically — orderBy not supported on implicit M2M
    const sbn = (a, b) => a.name.localeCompare(b.name);
    if (item.cast)      item.cast      = item.cast.sort(sbn);
    if (item.directors) item.directors = item.directors.sort(sbn);
    if (item.authors)   item.authors   = item.authors.sort(sbn);
    res.json(item);
  } catch (err) { next(err); }
});

// ─── DELETE /api/admin/media/:id ──────────────────────────────────────────
router.delete('/media/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.mediaItem.delete({ where: { id: req.params.id } });
    res.json({ message: 'Media item deleted' });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/settings ──────────────────────────────────────────────
router.get('/settings', requireAdmin, async (req, res, next) => {
  try {
    const settings = await prisma.adminSetting.findMany();
    res.json(Object.fromEntries(settings.map(s => [s.key, s.value])));
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/settings ────────────────────────────────────────────
router.patch('/settings', requireAdmin, async (req, res, next) => {
  try {
    const { feedTimeframeDays } = req.body;
    if (feedTimeframeDays !== undefined) {
      await prisma.adminSetting.upsert({
        where: { key: 'feedTimeframeDays' },
        update: { value: String(feedTimeframeDays) },
        create: { key: 'feedTimeframeDays', value: String(feedTimeframeDays) },
      });
    }
    res.json({ message: 'Settings updated' });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = 30;
    const where = req.query.q ? {
      OR: [
        { username:    { contains: req.query.q, mode: 'insensitive' } },
        { displayName: { contains: req.query.q, mode: 'insensitive' } },
        { email:       { contains: req.query.q, mode: 'insensitive' } },
      ],
    } : {};
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, username: true, displayName: true, email: true, avatarUrl: true, isAdmin: true, createdAt: true, _count: { select: { reviews: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take, take,
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total, page, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});


// ─── GET /api/admin/shows ─── Search TV shows for parent picker ───────────────
// Used by the "Add Season" form to find the parent show to link against.
// Returns only TV_SHOW type items that have no parentId (i.e. parent shows, not seasons).
router.get('/shows', requireAdmin, async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    const shows = await prisma.mediaItem.findMany({
      where: {
        mediaType: 'TV_SHOW',
        parentId:  null, // only parent shows, not season entries
        ...(q && { title: { contains: q, mode: 'insensitive' } }),
      },
      // Return all fields needed to auto-fill season entries when a show is selected
      select: {
        id: true, title: true, releaseYear: true, imageUrl: true,
        seasons: true, description: true, genres: true, tags: true, tmdbId: true,
        // Include cast so seasons can inherit the main cast — ordered by name for consistency
        cast: { select: { id: true, name: true }, take: 100 },
      },
      orderBy: { title: 'asc' },
      take: 20,
    });
    // Sort cast alphabetically — orderBy not supported on implicit M2M
    const sorted = shows.map(s => ({
      ...s,
      cast: (s.cast || []).sort((a, b) => a.name.localeCompare(b.name)),
    }));
    res.json(sorted);
  } catch (err) { next(err); }
});


// ─── GET /api/admin/season-data ──────────────────────────────────────────────
// Fetches the data from the most recent existing season of a show,
// so the admin can pre-fill cast and genres when adding a new season.
//
// Query params:
//   parentId    — ID of the parent show
//   seasonNumber — the season being added (we'll look for the previous one)
//
// Returns the closest previous season's cast, genres, and description
// so the admin can choose to copy them across.
router.get('/season-data', requireAdmin, async (req, res, next) => {
  try {
    const { parentId, seasonNumber } = req.query;

    if (!parentId) {
      return res.status(400).json({ error: 'parentId is required' });
    }

    const targetSeason = seasonNumber ? parseInt(seasonNumber) : null;

    // Find the most recent season that exists before the requested season number.
    // If no season number given, just return the most recent season overall.
    // We include cast (Person relations) and genres so the admin can copy them.
    const previousSeason = await prisma.mediaItem.findFirst({
      where: {
        parentId,
        mediaType: 'TV_SHOW',
        // If we know the target season, find the closest lower-numbered season
        ...(targetSeason ? { seasonNumber: { lt: targetSeason } } : {}),
      },
      include: {
        // Cast members — we'll return their names as a comma-separated string
        // so it can be pasted straight into the cast field
        cast: { select: { id: true, name: true }, take: 100 },
      },
      // Get the highest season number below the target — the most recent prior season
      orderBy: { seasonNumber: 'desc' },
    });

    if (!previousSeason) {
      // No previous season exists — return the parent show's cast and genres instead
      const parentShow = await prisma.mediaItem.findUnique({
        where: { id: parentId },
        include: { cast: { select: { id: true, name: true } } },
      });

      if (!parentShow) return res.status(404).json({ error: 'Show not found' });

      return res.json({
        source: 'parent_show',        // tells the frontend where this data came from
        sourceLabel: 'the main show entry',
        seasonNumber: null,
        cast: parentShow.cast.map(p => p.name),
        genres: parentShow.genres || [],
        description: parentShow.description || '',
        imageUrl: null,               // don't copy the show poster to individual seasons
      });
    }

    // Return the previous season's data
    res.json({
      source: 'previous_season',
      sourceLabel: `Season ${previousSeason.seasonNumber}`,
      seasonNumber: previousSeason.seasonNumber,
      cast: previousSeason.cast.map(p => p.name),  // array of name strings
      genres: previousSeason.genres || [],
      description: previousSeason.description || '',
      imageUrl: previousSeason.imageUrl || null,    // previous season's poster
    });

  } catch (err) { next(err); }
});


// ─── GET /api/admin/lookup/tmdb ───────────────────────────────────────────────
// Searches TMDB by title and returns candidates so the admin can pick one.
// Used in the admin form to auto-fill movie/TV show data.
// Query params: q (title), type (movie or tv)
router.get('/lookup/tmdb', requireAdmin, async (req, res, next) => {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: 'TMDB_READ_ACCESS_TOKEN not configured in Railway Variables' });

  const { q, type = 'movie' } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    // Search TMDB for matching titles
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const searchRes = await fetch(
      `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(q)}&include_adult=false`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!searchRes.ok) throw new Error('TMDB search failed');
    const searchData = await searchRes.json();

    // Return top 5 candidates with enough info to identify them
    const results = (searchData.results || []).slice(0, 5).map(item => ({
      tmdbId:      String(item.id),
      title:       item.title || item.name,
      releaseYear: (item.release_date || item.first_air_date || '').split('-')[0],
      overview:    item.overview,
      // TMDB poster URL — w500 is a good size for admin preview
      posterUrl:   item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
      rating:      item.vote_average,
    }));

    res.json(results);
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/tmdb/:id ──────────────────────────────────────────
// Fetches full details for a specific TMDB ID to populate all form fields.
router.get('/lookup/tmdb/:id', requireAdmin, async (req, res, next) => {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: 'TMDB_READ_ACCESS_TOKEN not configured' });

  const { type = 'movie' } = req.query;
  try {
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const detailRes = await fetch(
      `https://api.themoviedb.org/3/${endpoint}/${req.params.id}?append_to_response=credits`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!detailRes.ok) throw new Error('TMDB detail fetch failed');
    const data = await detailRes.json();

    // Extract and normalise the fields we care about
    const directors = (data.credits?.crew || [])
      .filter(p => p.job === 'Director')
      .map(p => p.name);

    const cast = (data.credits?.cast || [])
      .slice(0, 20) // top 20 cast members
      .map(p => p.name);

    // For TV shows, get creators instead of directors
    const creators = (data.created_by || []).map(p => p.name);

    res.json({
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
    });
  } catch (err) { next(err); }
});


// ─── Open Library genre filter ────────────────────────────────────────────────
// Open Library subjects are very noisy — they include things like
// "Protected DAISY", "In library", "Large type books", "Internet Archive Wishlist"
// alongside real genres. This filter strips non-genre entries and returns
// only clean, short, recognisable genre-like terms.
// Returns empty array if no clean genres found — better than garbage data.
function filterOpenLibraryGenres(subjects) {
  // Terms to always exclude — these are metadata tags not genres
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
      // Skip if it matches any blocklist term
      if (blocklist.some(b => lower.includes(b))) return false;
      // Skip if too long — real genres are short (max 4 words / 30 chars)
      if (s.length > 30) return false;
      // Skip if it looks like a place name used as a subject
      if (/^\d/.test(s)) return false;
      // Skip if it has parentheses — usually "(Fictitious character)" etc
      if (s.includes('(') || s.includes(')')) return false;
      return true;
    })
    .slice(0, 5); // return max 5 clean genres
}

// ─── GET /api/admin/lookup/openlibrary ───────────────────────────────────────
// Searches Open Library by title and returns candidates for books.
router.get('/lookup/openlibrary', requireAdmin, async (req, res, next) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const searchRes = await fetch(
      `https://openlibrary.org/search.json?title=${encodeURIComponent(q)}&limit=5&fields=key,title,author_name,first_publish_year,cover_i,subject`
    );
    if (!searchRes.ok) throw new Error('Open Library search failed');
    const data = await searchRes.json();

    const results = (data.docs || []).slice(0, 5).map(item => ({
      openLibraryId: item.key?.replace('/works/', ''), // e.g. OL45804W
      title:         item.title,
      authors:       item.author_name || [],
      releaseYear:   item.first_publish_year || null,
      // Cover art URL using cover_i (cover ID)
      imageUrl:      item.cover_i
        ? `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg`
        : null,
      genres: filterOpenLibraryGenres(item.subject || []),
    }));

    res.json(results);
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/openlibrary/:id ────────────────────────────────────
// Fetches full details for a specific Open Library work ID.
router.get('/lookup/openlibrary/:id', requireAdmin, async (req, res, next) => {
  try {
    // Fetch work details and editions in parallel for speed.
    // The work endpoint has description and subjects but often lacks publish year.
    // The editions endpoint reliably has publish_date on individual editions.
    const [workRes, editionsRes] = await Promise.all([
      fetch(`https://openlibrary.org/works/${req.params.id}.json`),
      fetch(`https://openlibrary.org/works/${req.params.id}/editions.json?limit=10`),
    ]);

    if (!workRes.ok) throw new Error('Open Library fetch failed');
    const data     = await workRes.json();
    const editions = editionsRes.ok ? await editionsRes.json() : null;

    // Fetch author names separately — the work only has author key IDs
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

    // Description can be a plain string or { value: "..." } object
    const description = typeof data.description === 'string'
      ? data.description
      : data.description?.value || '';

    // Cover ID — try work record first, then fall back to editions.
    // Many books only have covers attached to edition records, not the work itself.
    let coverId = data.covers?.[0] || null;

    if (!coverId && editions?.entries?.length) {
      // Find the first edition that has a cover
      for (const edition of editions.entries) {
        if (edition.covers?.[0]) {
          coverId = edition.covers[0];
          break;
        }
      }
    }

    // ── Determine release year ────────────────────────────────────────────────
    // Priority order:
    // 1. first_publish_year passed from the search result (most reliable)
    // 2. first_publish_date on the work record (often missing or malformed)
    // 3. Earliest publish_date from editions (reliable but needs parsing)
    let releaseYear = null;

    // 1. Year passed from search as query param (e.g. ?year=1954)
    if (req.query.year) {
      releaseYear = parseInt(req.query.year);
    }

    // 2. first_publish_date on work — extract 4-digit year from string
    if (!releaseYear && data.first_publish_date) {
      const match = String(data.first_publish_date).match(/\d{4}/);
      if (match) releaseYear = parseInt(match[0]);
    }

    // 3. Earliest year from editions
    if (!releaseYear && editions?.entries?.length) {
      const years = editions.entries
        .map(e => {
          const m = String(e.publish_date || '').match(/\d{4}/);
          return m ? parseInt(m[0]) : null;
        })
        .filter(y => y && y > 1000 && y < 2100);
      if (years.length) releaseYear = Math.min(...years);
    }

    res.json({
      openLibraryId: req.params.id,
      title:         data.title,
      description:   description.slice(0, 1000),
      authors:       authorNames.filter(Boolean),
      releaseYear,
      imageUrl:      coverId
        ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
        : null,
      genres: filterOpenLibraryGenres(data.subjects || []),
    });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/igdb ───────────────────────────────────────────────
// Searches IGDB by title for video games.
router.get('/lookup/igdb', requireAdmin, async (req, res, next) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  const clientId     = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({ error: 'IGDB_CLIENT_ID and IGDB_CLIENT_SECRET not configured in Railway Variables' });
  }

  try {
    // Get Twitch OAuth token for IGDB
    const tokenRes = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      { method: 'POST' }
    );
    if (!tokenRes.ok) throw new Error('IGDB auth failed');
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    // Search IGDB
    const searchRes = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID':     clientId,
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'text/plain',
      },
      // Search by name, get cover art and basic info
      body: `search "${q}"; fields name,cover.url,first_release_date,genres.name,involved_companies.company.name,summary,rating; limit 5;`,
    });
    if (!searchRes.ok) throw new Error('IGDB search failed');
    const games = await searchRes.json();

    const results = games.map(game => ({
      igdbId:      String(game.id),
      title:       game.name,
      releaseYear: game.first_release_date
        ? new Date(game.first_release_date * 1000).getFullYear()
        : null,
      description: game.summary || null,
      // IGDB cover URLs need //images.igdb.com → https://images.igdb.com
      // and t_thumb → t_cover_big for a better size
      imageUrl:    game.cover?.url
        ? 'https:' + game.cover.url.replace('t_thumb', 't_cover_big')
        : null,
      genres:      (game.genres || []).map(g => g.name),
      developers:  (game.involved_companies || []).map(c => c.company?.name).filter(Boolean),
      rating:      game.rating ? Math.round(game.rating) : null,
    }));

    res.json(results);
  } catch (err) { next(err); }
});


// ─── GET /api/admin/check-duplicate ──────────────────────────────────────────
// Quick check before adding a title — returns any existing items with the
// same title (case-insensitive) and optionally the same media type.
// Used by the admin form to warn before submitting a duplicate.
router.get('/check-duplicate', requireAdmin, async (req, res, next) => {
  try {
    const { title, type } = req.query;
    if (!title) return res.json({ duplicates: [] });

    const duplicates = await prisma.mediaItem.findMany({
      where: {
        title: { equals: title.trim(), mode: 'insensitive' },
        ...(type ? { mediaType: type } : {}),
      },
      select: {
        id: true, title: true, mediaType: true,
        releaseYear: true, slug: true, imageUrl: true,
      },
      take: 5,
    });

    res.json({ duplicates });
  } catch (err) { next(err); }
});


// ─── GET /api/admin/media/by-slug/:slug ──────────────────────────────────────
// Returns full item data for the edit form — no redirect logic, no aggregation.
// Used by the Edit Media tab so single-season TV parents load correctly.
router.get('/media/by-slug/:slug', requireAdmin, async (req, res, next) => {
  try {
    const item = await prisma.mediaItem.findUnique({
      where: { slug: req.params.slug },
      include: {
        directors: { select: { id: true, name: true }, take: 100 },
        cast:       { select: { id: true, name: true }, take: 100 },
        authors:    { select: { id: true, name: true }, take: 100 },
      },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
});

module.exports = router;
