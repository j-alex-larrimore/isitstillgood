// src/routes/admin.js
const router = require('express').Router();

const { body, query, validationResult } = require('express-validator');
const prisma  = require('../lib/prisma');
const { requireAdmin } = require('../middleware/admin');
const { fetchExternalRatings } = require('../services/externalRatings');
const {
  normalizeTags, normalizeGenres, normalizeGameGenres, normalizeBookGenres,
  slugify, uniqueSlug, connectPersons,
} = require('../lib/mediaHelpers');

// Genres are normalized server-side, by mediaType, no matter what the
// client sends — the admin UI's single-add and edit forms used to write
// raw external-API genre strings straight through (e.g. IGDB's "Hack and
// slash/Beat 'em up", TMDB's unsplit "Sci-Fi & Fantasy"), which is how
// those ended up inconsistent with the bulk-import/sync paths that already
// called the right normalizer.
function normalizeGenresForType(mediaType, genres) {
  if (!Array.isArray(genres)) return genres;
  if (mediaType === 'BOOK') return normalizeBookGenres(genres);
  if (mediaType === 'VIDEO_GAME') return normalizeGameGenres(genres);
  return normalizeGenres(genres);
}
const {
  searchTmdb, getTmdbDetail,
  searchGoogleBooks, getGoogleBooksDetail,
  searchOpenLibrary, getOpenLibraryDetail,
  searchIgdb,
} = require('../services/mediaLookup');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
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

    // Notify the requester that their title has been added
    if (request.userId) {
      await prisma.notification.create({
        data: {
          userId:  request.userId,
          type:    'REQUEST_ADDED',
          payload: {
            title:     request.title,
            mediaType: request.mediaType,
          },
        },
      }).catch(console.error); // non-blocking
    }

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
        genres:          normalizeGenresForType(mediaType, genres || []),
        // Tags — franchise, studio, network etc. e.g. "Marvel", "HBO", "Star Wars"
        tags:            normalizeTags(tags || []),
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
        seriesNumber:    seriesNumber ? parseFloat(seriesNumber) : null,
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
      'seasons','seriesName','seriesNumber','verified',
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

    // Normalize tags if being updated
    if (data.tags) data.tags = normalizeTags(data.tags);

    // Normalize genres if being updated — mediaType isn't in the request
    // body (it's immutable after creation), so look up the existing row's.
    if (data.genres) {
      const existing = await prisma.mediaItem.findUnique({
        where: { id: req.params.id },
        select: { mediaType: true },
      });
      if (existing) data.genres = normalizeGenresForType(existing.mediaType, data.genres);
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
  if (!process.env.TMDB_READ_ACCESS_TOKEN) return res.status(503).json({ error: 'TMDB_READ_ACCESS_TOKEN not configured in Railway Variables' });
  const { q, type = 'movie', year } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    res.json(await searchTmdb(q, type, year));
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/tmdb/:id ──────────────────────────────────────────
// Fetches full details for a specific TMDB ID to populate all form fields.
router.get('/lookup/tmdb/:id', requireAdmin, async (req, res, next) => {
  if (!process.env.TMDB_READ_ACCESS_TOKEN) return res.status(503).json({ error: 'TMDB_READ_ACCESS_TOKEN not configured' });
  try {
    res.json(await getTmdbDetail(req.params.id, req.query.type || 'movie'));
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/googlebooks ───────────────────────────────────────
// Searches Google Books API by title (with optional author/year filters).
// Much better coverage than Open Library for modern and popular titles.
router.get('/lookup/googlebooks', requireAdmin, async (req, res, next) => {
  const { q, author, year } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  if (!process.env.GOOGLE_BOOKS_API_KEY) return res.status(503).json({ error: 'GOOGLE_BOOKS_API_KEY not configured in Railway Variables' });
  try {
    res.json(await searchGoogleBooks(q, author, year));
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/googlebooks/:id ────────────────────────────────────
// Fetches full details for a specific Google Books volume ID.
router.get('/lookup/googlebooks/:id', requireAdmin, async (req, res, next) => {
  if (!process.env.GOOGLE_BOOKS_API_KEY) return res.status(503).json({ error: 'GOOGLE_BOOKS_API_KEY not configured' });
  try {
    res.json(await getGoogleBooksDetail(req.params.id));
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/openlibrary ───────────────────────────────────────
// Searches Open Library by title and returns candidates for books.
router.get('/lookup/openlibrary', requireAdmin, async (req, res, next) => {
  const { q, year, author } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    res.json(await searchOpenLibrary(q, year, author));
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/openlibrary/:id ────────────────────────────────────
// Fetches full details for a specific Open Library work ID.
router.get('/lookup/openlibrary/:id', requireAdmin, async (req, res, next) => {
  try {
    res.json(await getOpenLibraryDetail(req.params.id, req.query.year));
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/igdb ───────────────────────────────────────────────
// Searches IGDB by title for video games.
router.get('/lookup/igdb', requireAdmin, async (req, res, next) => {
  const { q, year } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  if (!process.env.IGDB_CLIENT_ID || !process.env.IGDB_CLIENT_SECRET) {
    return res.status(503).json({ error: 'IGDB_CLIENT_ID and IGDB_CLIENT_SECRET not configured in Railway Variables' });
  }
  try {
    res.json(await searchIgdb(q, year));
  } catch (err) { next(err); }
});

// ─── GET /api/admin/check-duplicate ──────────────────────────────────────────
// Quick check before adding a title — returns any existing items with the
// same title (case-insensitive) and optionally the same media type.
// Used by the admin form to warn before submitting a duplicate.
router.get('/check-duplicate', requireAdmin, async (req, res, next) => {
  try {
    const { title, type, tmdbId, igdbId, openLibraryId } = req.query;

    // Check by external ID first — most reliable dedup signal.
    // IMPORTANT: TMDB uses separate ID spaces for movies and TV shows, so
    // a tmdbId match must also match mediaType to avoid false positives.
    const idChecks = [];
    if (tmdbId) {
      const tmdbCheck = { tmdbId };
      // If we know the type, restrict to that type so movie/2698 != tv/2698
      if (type === 'MOVIE')   tmdbCheck.mediaType = 'MOVIE';
      if (type === 'TV_SHOW') tmdbCheck.mediaType = 'TV_SHOW';
      idChecks.push(tmdbCheck);
    }
    if (igdbId)        idChecks.push({ openCriticId: igdbId });
    if (openLibraryId) idChecks.push({ goodreadsId: openLibraryId });

    let idMatches = [];
    if (idChecks.length) {
      idMatches = await prisma.mediaItem.findMany({
        where: { OR: idChecks },
        select: { id: true, title: true, mediaType: true, releaseYear: true, slug: true, imageUrl: true },
        take: 5,
      });
    }

    // Also check by title (case-insensitive)
    let titleMatches = [];
    if (title) {
      titleMatches = await prisma.mediaItem.findMany({
        where: {
          title: { equals: title.trim(), mode: 'insensitive' },
          ...(type ? { mediaType: type } : {}),
        },
        select: { id: true, title: true, mediaType: true, releaseYear: true, slug: true, imageUrl: true },
        take: 5,
      });
    }

    // Merge, deduplicating by id
    const seen = new Set();
    const duplicates = [...idMatches, ...titleMatches].filter(d => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });

    res.json({ duplicates, idMatch: idMatches.length > 0 });
  } catch (err) { next(err); }
});


// ─── GET /api/admin/media/search ─── Search all items including TV parents ──
router.get('/media/search', requireAdmin, async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (!q || q.length < 2) return res.json([]);

    const items = await prisma.mediaItem.findMany({
      where: {
        title: { contains: q, mode: 'insensitive' },
      },
      select: {
        id: true, slug: true, title: true, mediaType: true,
        releaseYear: true, imageUrl: true, parentId: true, seriesName: true,
      },
      orderBy: { title: 'asc' },
      take: 15,
    });

    res.json({ items });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/media/pending ─── Items awaiting review ──────────────────
// Anything created via scripts/bulk-import.js or the admin bulk-import route
// lands here with verified:false until an admin approves it (PATCH
// /api/admin/media/:id with { verified: true }) — see the "verified" field
// comment in prisma/schema.prisma for why. Newest imports first.
router.get('/media/pending', requireAdmin, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = 50;
    // parentId:null — only top-level items (movies, books, games, TV parent
    // shows) show up as their own review row. A season is reviewed as part
    // of its parent show's row (see seasonEntries below), never standalone.
    const where = { verified: false, parentId: null };
    const [items, total] = await Promise.all([
      prisma.mediaItem.findMany({
        where,
        select: {
          id: true, slug: true, title: true, mediaType: true, releaseYear: true,
          imageUrl: true, description: true, genres: true, tags: true,
          seriesName: true, seriesNumber: true, tmdbId: true, tmdbRating: true,
          goodreadsId: true, openCriticId: true, openCriticScore: true,
          seasons: true, createdAt: true,
          directors: { select: { id: true, name: true }, take: 50 },
          authors:   { select: { id: true, name: true }, take: 50 },
          cast:      { select: { id: true, name: true }, take: 50 },
          // TV parent shows — include existing seasons (regardless of their
          // own verified state) so cast/guest-star edits can happen inline
          // alongside the parent's review, without a separate lookup.
          seasonEntries: {
            where: { seasonNumber: { not: null } },
            select: {
              id: true, title: true, seasonNumber: true, releaseYear: true, excludedCast: true,
              cast: { select: { id: true, name: true }, take: 50 },
            },
            orderBy: { seasonNumber: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take, take,
      }),
      prisma.mediaItem.count({ where }),
    ]);
    res.json({ items, total, page, pages: Math.ceil(total / take) });
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


// ─── GET /api/admin/lookup/tmdb-collection ─── Search TMDB collections ──────
router.get('/lookup/tmdb-collection', requireAdmin, async (req, res, next) => {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: 'TMDB_READ_ACCESS_TOKEN not configured' });
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: 'Query required' });
  try {
    // Search for collections
    const r = await fetch(
      `https://api.themoviedb.org/3/search/collection?query=${encodeURIComponent(q)}&language=en-US`,
      { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } }
    );
    const data = await r.json();
    const results = (data.results || []).slice(0, 15).map(c => ({
      id:       c.id,
      name:     c.name,
      overview: c.overview,
      imageUrl: c.poster_path ? `https://image.tmdb.org/t/p/w200${c.poster_path}` : null,
    }));
    res.json(results);
  } catch (err) { next(err); }
});

// ─── GET /api/admin/lookup/tmdb-collection/:id ─── Get all movies in collection ──
router.get('/lookup/tmdb-collection/:id', requireAdmin, async (req, res, next) => {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: 'TMDB_READ_ACCESS_TOKEN not configured' });
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3/collection/${req.params.id}?language=en-US`,
      { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } }
    );
    const data = await r.json();
    const movies = await Promise.all((data.parts || [])
      .sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''))
      .map(async m => {
        // Fetch full details including credits for each movie
        const dr = await fetch(
          `https://api.themoviedb.org/3/movie/${m.id}?append_to_response=credits&language=en-US`,
          { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } }
        );
        const detail = await dr.json();
        return {
          tmdbId:      String(m.id),
          title:       detail.title,
          releaseYear: detail.release_date ? parseInt(detail.release_date) : null,
          description: detail.overview || null,
          imageUrl:    detail.poster_path ? `https://image.tmdb.org/t/p/w500${detail.poster_path}` : null,
          tmdbRating:  detail.vote_average ? Math.round(detail.vote_average * 10) / 10 : null,
          genres:      (detail.genres || []).map(g => g.name).slice(0, 5),
          directors:   (detail.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name),
          cast:        (detail.credits?.cast || []).slice(0, 20).map(c => c.name),
        };
      })
    );
    res.json({ name: data.name, movies });
  } catch (err) { next(err); }
});

// ─── POST /api/admin/bulk-import ─── Import multiple movies at once ──────────
router.post('/bulk-import', requireAdmin, async (req, res, next) => {
  const { movies, tags } = req.body; // movies: array of movie objects from TMDB
  if (!Array.isArray(movies) || !movies.length) {
    return res.status(400).json({ error: 'movies array required' });
  }
  const results = { added: [], skipped: [], failed: [] };
  for (const m of movies) {
    try {
      // Skip if already exists by tmdbId
      const existing = await prisma.mediaItem.findFirst({ where: { tmdbId: m.tmdbId } });
      if (existing) { results.skipped.push(m.title); continue; }

      const finalTitle = m.title;
      const slug = await uniqueSlug(slugify(finalTitle, m.releaseYear));
      await prisma.mediaItem.create({
        data: {
          mediaType:   'MOVIE',
          title:       finalTitle,
          slug,
          releaseYear: m.releaseYear,
          verified:    false, // queues for admin review before showing up publicly
          description: m.description,
          imageUrl:    m.imageUrl,
          genres:      m.genres || [],
          tags:        [...(tags || []), ...(m.extraTags || [])]
                       .map(t => t.trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')),
          tmdbId:      m.tmdbId,
          tmdbRating:  m.tmdbRating,
          directors:   await connectPersons(m.directors || []),
          cast:        await connectPersons(m.cast || []),
        },
      });
      results.added.push(m.title);
    } catch (err) {
      results.failed.push({ title: m.title, error: err.message });
    }
  }
  res.json(results);
});

module.exports = router;
