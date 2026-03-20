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

async function connectPersons(names) {
  if (!names?.length) return undefined;
  const persons = await Promise.all(names.map(name => {
    const personSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return prisma.person.upsert({
      where: { slug: personSlug },
      update: { name },
      create: { name, slug: personSlug },
    });
  }));
  return { connect: persons.map(p => ({ id: p.id })) };
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
      imdbId, goodreadsId, openCriticId,
      // Movie
      directorNames, castNames, mpaaRating,
      // TV Show — parent show fields (seasons = total count on parent row)
      seasons,
      // TV Season — used when adding a season linked to a parent show
      parentId,        // ID of the parent show MediaItem row
      seasonNumber,    // which season this entry represents (1, 2, 3…)
      rtScore,         // manual RT critics score 0–100
      rtAudienceScore, // manual RT audience score 0–100
      // Book
      authorNames, seriesName, seriesNumber,
      // Video game
      openCriticId: ocId,
    } = req.body;

    // For TV seasons, auto-build the title as "Show Name — Season N"
    // when a parentId is supplied and the user hasn't already included "season"
    let finalTitle = title;
    if (mediaType === 'TV_SHOW' && parentId && seasonNumber) {
      const parentShow = await prisma.mediaItem.findUnique({
        where: { id: parentId },
        select: { title: true },
      });
      if (parentShow && !title.toLowerCase().includes('season')) {
        finalTitle = `${parentShow.title} — Season ${seasonNumber}`;
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
        imdbId:          imdbId      || null,
        goodreadsId:     goodreadsId || null,
        openCriticId:    openCriticId || ocId || null,
        mpaaRating:      mpaaRating  || null,
        // TV parent show — total season count
        seasons:         seasons     ? parseInt(seasons)      : null,
        // TV season — link to parent and record season number
        parentId:        parentId    || null,
        seasonNumber:    seasonNumber ? parseInt(seasonNumber) : null,
        // RT scores entered manually
        rtScore:         rtScore         ? parseInt(rtScore)         : null,
        rtAudienceScore: rtAudienceScore ? parseInt(rtAudienceScore) : null,
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

    if (imdbId || goodreadsId || openCriticId) {
      fetchExternalRatings(item.id).catch(console.error);
    }

    res.status(201).json(item);
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/media/:id ───────────────────────────────────────────
router.patch('/media/:id', requireAdmin, async (req, res, next) => {
  try {
    const allowed = [
      'title','description','imageUrl','genres','releaseYear',
      'imdbId','imdbRating','rtScore','rtAudienceScore',
      'goodreadsId','goodreadsRating','openCriticId','openCriticScore',
      'metacriticScore','mpaaRating','seasons',
      'seriesName','seriesNumber',
    ];
    const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const item = await prisma.mediaItem.update({ where: { id: req.params.id }, data });
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
      select: { id: true, title: true, releaseYear: true, imageUrl: true, seasons: true },
      orderBy: { title: 'asc' },
      take: 20,
    });
    res.json(shows);
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
        cast: { select: { id: true, name: true } },
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

module.exports = router;
