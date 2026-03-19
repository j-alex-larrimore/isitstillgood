// src/routes/media.js
const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { optionalAuth } = require('../middleware/auth');
const { fetchExternalRatings } = require('../services/externalRatings');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

// ─── GET /api/media ─── Search / browse with unreviewed filter ───────────
router.get('/', optionalAuth, [
  query('q').optional().trim(),
  query('type').optional().isIn(['MOVIE','BOOK','TV_SHOW','BOARD_GAME','VIDEO_GAME']),
  query('genre').optional().trim(),
  query('year').optional().isInt({ min: 1800, max: 2200 }),
  query('person').optional().trim(),   // director, actor, author name search
  query('excludeReviewed').optional().isBoolean(),
  query('sort').optional().isIn(['rating', 'recent', 'title', 'year']),
  query('page').optional().isInt({ min: 1 }),
], async (req, res, next) => {
  const { q, type, genre, year, person, page = 1, sort = 'recent' } = req.query;
  const excludeReviewed = req.query.excludeReviewed === 'true' && req.user;
  const take = 24;

  try {
    // If person search, find matching person IDs first
    let personFilter = undefined;
    if (person) {
      const persons = await prisma.person.findMany({
        where: { name: { contains: person, mode: 'insensitive' } },
        select: { id: true },
      });
      const ids = persons.map(p => p.id);
      if (ids.length) {
        personFilter = {
          OR: [
            { directors: { some: { id: { in: ids } } } },
            { cast:      { some: { id: { in: ids } } } },
            { authors:   { some: { id: { in: ids } } } },
          ],
        };
      } else {
        // No matching persons — return empty
        return res.json({ items: [], total: 0, page: parseInt(page), pages: 0 });
      }
    }

    // Get IDs of items the user has already reviewed
    let reviewedIds = [];
    if (excludeReviewed) {
      const reviewed = await prisma.review.findMany({
        where: { userId: req.user.id },
        select: { mediaItemId: true },
      });
      reviewedIds = reviewed.map(r => r.mediaItemId);
    }

    const where = {
      ...(type  && { mediaType: type }),
      ...(year  && { releaseYear: parseInt(year) }),
      ...(genre && { genres: { has: genre } }),
      ...(q && {
        OR: [
          { title:       { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      }),
      ...(personFilter),
      ...(excludeReviewed && reviewedIds.length && { id: { notIn: reviewedIds } }),
    };

    const orderBy = {
      rating:  [{ reviews: { _count: 'desc' } }],
      recent:  [{ createdAt: 'desc' }],
      title:   [{ title: 'asc' }],
      year:    [{ releaseYear: 'desc' }],
    }[sort] || [{ createdAt: 'desc' }];

    const [items, total] = await Promise.all([
      prisma.mediaItem.findMany({
        where,
        include: {
          _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
          directors: { select: { id: true, name: true, slug: true } },
          authors:   { select: { id: true, name: true, slug: true } },
          cast:      { select: { id: true, name: true, slug: true } },
        },
        orderBy,
        skip: (parseInt(page) - 1) * take,
        take,
      }),
      prisma.mediaItem.count({ where }),
    ]);

    // For each item, compute community avg rating
    const itemIds = items.map(i => i.id);
    const ratings = await prisma.review.groupBy({
      by: ['mediaItemId'],
      where: { mediaItemId: { in: itemIds }, visibility: 'PUBLIC' },
      _avg: { rating: true },
    });
    const ratingMap = Object.fromEntries(ratings.map(r => [r.mediaItemId, r._avg.rating]));

    res.json({
      items: items.map(i => ({ ...i, avgRating: ratingMap[i.id] || null })),
      total, page: parseInt(page), pages: Math.ceil(total / take),
    });
  } catch (err) { next(err); }
});

// ─── GET /api/media/:slug ─────────────────────────────────────────────────
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
    if (!item) return res.status(404).json({ error: 'Not found' });

    const stats = await prisma.review.aggregate({
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const verdicts = await prisma.review.groupBy({
      by: ['verdict'],
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      _count: { verdict: true },
    });

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

// ─── GET /api/media/:slug/reviews ─────────────────────────────────────────
router.get('/:slug/reviews', optionalAuth, [
  query('page').optional().isInt({ min: 1 }),
  query('sort').optional().isIn(['recent', 'top']),
], async (req, res, next) => {
  try {
    const item = await prisma.mediaItem.findUnique({ where: { slug: req.params.slug } });
    if (!item) return res.status(404).json({ error: 'Not found' });
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
        skip: (page - 1) * take, take,
      }),
      prisma.review.count({ where: { mediaItemId: item.id, visibility: 'PUBLIC' } }),
    ]);
    res.json({ reviews, total, page, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// ─── POST /api/media/:id/sync-ratings ────────────────────────────────────
router.post('/:id/sync-ratings', async (req, res, next) => {
  try {
    const updated = await fetchExternalRatings(req.params.id);
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
