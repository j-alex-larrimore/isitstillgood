// src/routes/media.js
const router = require('express').Router();
const { body, query, param, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { fetchExternalRatings } = require('../services/externalRatings');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

// Slugify helper
function slugify(title, year) {
  const base = title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return year ? `${base}-${year}` : base;
}

// ─── GET /api/media ─── Search / list ─────────────────────────────────────
router.get('/', optionalAuth, [
  query('q').optional().trim(),
  query('type').optional().isIn(['MOVIE','BOOK','TV_SHOW','BOARD_GAME','VIDEO_GAME']),
  query('genre').optional().trim(),
  query('year').optional().isInt({ min: 1800, max: 2100 }),
  query('page').optional().isInt({ min: 1 }),
], async (req, res, next) => {
  const { q, type, genre, year, page = 1 } = req.query;
  const take = 24;
  try {
    const where = {
      ...(type  && { mediaType: type }),
      ...(year  && { releaseYear: parseInt(year) }),
      ...(genre && { genres: { has: genre } }),
      ...(q     && {
        OR: [
          { title:       { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      prisma.mediaItem.findMany({
        where,
        include: {
          _count: { select: { reviews: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * take,
        take,
      }),
      prisma.mediaItem.count({ where }),
    ]);

    res.json({ items, total, page: parseInt(page), pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// ─── GET /api/media/:slug ─── Single item detail ──────────────────────────
router.get('/:slug', optionalAuth, async (req, res, next) => {
  try {
    const item = await prisma.mediaItem.findUnique({
      where: { slug: req.params.slug },
      include: {
        directors: { select: { id: true, name: true, slug: true, imageUrl: true } },
        cast:       { select: { id: true, name: true, slug: true, imageUrl: true } },
        authors:    { select: { id: true, name: true, slug: true, imageUrl: true } },
        designers:  { select: { id: true, name: true, slug: true, imageUrl: true } },
        _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
      },
    });

    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Compute community stats
    const stats = await prisma.review.aggregate({
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      _avg: { rating: true },
      _count: { rating: true },
    });

    // Verdict breakdown
    const verdicts = await prisma.review.groupBy({
      by: ['verdict'],
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      _count: { verdict: true },
    });

    // If viewer is logged in, fetch their own review
    let userReview = null;
    if (req.user) {
      userReview = await prisma.review.findUnique({
        where: { userId_mediaItemId: { userId: req.user.id, mediaItemId: item.id } },
      });
    }

    res.json({
      ...item,
      communityStats: {
        avgRating: stats._avg.rating,
        reviewCount: stats._count.rating,
        verdicts: Object.fromEntries(verdicts.map(v => [v.verdict, v._count.verdict])),
      },
      userReview,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/media ─── Create a media item ──────────────────────────────
router.post('/', requireAuth, [
  body('mediaType').isIn(['MOVIE','BOOK','TV_SHOW','BOARD_GAME','VIDEO_GAME']),
  body('title').trim().notEmpty(),
  body('releaseYear').optional().isInt({ min: 1800, max: 2100 }),
  body('description').optional().trim(),
  body('genres').optional().isArray(),
  body('imageUrl').optional().isURL(),
  body('imdbId').optional().trim(),
  body('goodreadsId').optional().trim(),
  body('openCriticId').optional().trim(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const { mediaType, title, releaseYear, description, genres = [],
            imageUrl, imdbId, goodreadsId, openCriticId,
            directors, cast, authors, designers,
            // Movie/TV
            studio, runtime, seasons, episodes, streamingOn, mpaaRating,
            // Book
            isbn, publisher, pageCount,
            // Game
            publishers, minPlayers, maxPlayers, playTimeMinutes, platforms } = req.body;

    const slug = await uniqueSlug(slugify(title, releaseYear));

    const item = await prisma.mediaItem.create({
      data: {
        mediaType, title, slug, releaseYear, description, genres, imageUrl,
        imdbId, goodreadsId, openCriticId,
        studio, runtime, seasons, episodes,
        streamingOn: streamingOn || [],
        mpaaRating, isbn, publisher, pageCount,
        publishers: publishers || [],
        minPlayers, maxPlayers, playTimeMinutes,
        platforms: platforms || [],
        directors: directors?.length ? { connect: directors.map(id => ({ id })) } : undefined,
        cast:      cast?.length      ? { connect: cast.map(id => ({ id })) }      : undefined,
        authors:   authors?.length   ? { connect: authors.map(id => ({ id })) }   : undefined,
        designers: designers?.length ? { connect: designers.map(id => ({ id })) } : undefined,
      },
    });

    // Kick off async external rating fetch if we have IDs
    if (imdbId || goodreadsId || openCriticId) {
      fetchExternalRatings(item.id).catch(console.error);
    }

    res.status(201).json(item);
  } catch (err) { next(err); }
});

// ─── PATCH /api/media/:id ─── Update a media item ─────────────────────────
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const allowed = [
      'title','description','imageUrl','genres','releaseYear',
      'imdbId','rtScore','goodreadsId','openCriticId',
      'studio','runtime','seasons','episodes','streamingOn','mpaaRating',
      'isbn','publisher','pageCount',
      'publishers','minPlayers','maxPlayers','playTimeMinutes','platforms',
    ];
    const data = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const item = await prisma.mediaItem.update({ where: { id: req.params.id }, data });
    res.json(item);
  } catch (err) { next(err); }
});

// ─── POST /api/media/:id/sync-ratings ─── Force re-fetch external ratings ─
router.post('/:id/sync-ratings', requireAuth, async (req, res, next) => {
  try {
    const updated = await fetchExternalRatings(req.params.id);
    res.json(updated);
  } catch (err) { next(err); }
});

// ─── GET /api/media/:slug/reviews ─── Reviews for an item ─────────────────
router.get('/:slug/reviews', optionalAuth, [
  query('page').optional().isInt({ min: 1 }),
  query('sort').optional().isIn(['recent', 'top']),
], async (req, res, next) => {
  try {
    const item = await prisma.mediaItem.findUnique({ where: { slug: req.params.slug } });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const page = parseInt(req.query.page) || 1;
    const take = 20;

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where: { mediaItemId: item.id, visibility: 'PUBLIC' },
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          _count: { select: { reactions: true, comments: true } },
        },
        orderBy: req.query.sort === 'top'
          ? [{ reactions: { _count: 'desc' } }]
          : [{ createdAt: 'desc' }],
        skip: (page - 1) * take,
        take,
      }),
      prisma.review.count({ where: { mediaItemId: item.id, visibility: 'PUBLIC' } }),
    ]);

    res.json({ reviews, total, page, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function uniqueSlug(base) {
  let slug = base, i = 1;
  while (await prisma.mediaItem.findUnique({ where: { slug } })) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

module.exports = router;
