// src/routes/media.js
const router = require('express').Router();
const { query } = require('express-validator');
const prisma = require('../lib/prisma');
const { optionalAuth } = require('../middleware/auth');
const { fetchExternalRatings } = require('../services/externalRatings');

// ─── GET /api/media ───────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res, next) => {
  const { q, type, genre, year, person, page = 1, sort = 'recent' } = req.query;
  // reviewedBy: a username — filter to only items reviewed by that specific user
  const reviewedBy = req.query.reviewedBy?.trim();
  const excludeReviewed = req.query.excludeReviewed === 'true' && req.user;
  const take = 24;

  try {
    // reviewedBy filter — look up the user and get their reviewed item IDs
    let reviewedByIds = undefined;
    if (reviewedBy) {
      const reviewedByUser = await prisma.user.findFirst({
        where: {
          OR: [
            { username:    { equals: reviewedBy, mode: 'insensitive' } },
            { displayName: { contains: reviewedBy, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      if (reviewedByUser) {
        // Get all media IDs this user has reviewed publicly
        const theirReviews = await prisma.review.findMany({
          where: { userId: reviewedByUser.id, visibility: { in: ['PUBLIC', 'FRIENDS_ONLY'] } },
          select: { mediaItemId: true, rating: true },
        });
        reviewedByIds = theirReviews.map(r => r.mediaItemId);
        // Store ratings for enriching results later
        req.reviewedByRatings = Object.fromEntries(theirReviews.map(r => [r.mediaItemId, r.rating]));
      } else {
        // User not found — return empty results rather than ignoring the filter
        return res.json({ items: [], total: 0, page: parseInt(page), pages: 0, reviewedByNotFound: true });
      }
    }

    // Person search — look up matching person IDs
    let personFilter = undefined;
    if (person && person.trim().length > 0) {
      const persons = await prisma.person.findMany({
        where: { name: { contains: person.trim(), mode: 'insensitive' } },
        select: { id: true },
      });
      if (!persons.length) {
        return res.json({ items: [], total: 0, page: parseInt(page), pages: 0 });
      }
      const ids = persons.map(p => p.id);
      personFilter = {
        OR: [
          { directors: { some: { id: { in: ids } } } },
          { cast:      { some: { id: { in: ids } } } },
          { authors:   { some: { id: { in: ids } } } },
        ],
      };
    }

    // Genre search — check both genres array and title/description
    let genreFilter = undefined;
    if (genre && genre.trim().length > 0) {
      genreFilter = { genres: { has: genre.trim() } };
    }

    // Text search across title, description, series name
    let textFilter = undefined;
    if (q && q.trim().length > 0) {
      textFilter = {
        OR: [
          { title:       { contains: q.trim(), mode: 'insensitive' } },
          { description: { contains: q.trim(), mode: 'insensitive' } },
          { seriesName:  { contains: q.trim(), mode: 'insensitive' } },
          // Also search via person names in the same query
          { directors: { some: { name: { contains: q.trim(), mode: 'insensitive' } } } },
          { cast:      { some: { name: { contains: q.trim(), mode: 'insensitive' } } } },
          { authors:   { some: { name: { contains: q.trim(), mode: 'insensitive' } } } },
        ],
      };
    }

    // Excluded already-reviewed items
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
      // Exact year match (legacy) OR year range if from/to are provided
      ...(year && !req.query.yearFrom && !req.query.yearTo
        ? { releaseYear: parseInt(year) }
        : {}),
      // Year range — yearFrom and yearTo can be used independently
      ...(req.query.yearFrom || req.query.yearTo ? {
        releaseYear: {
          ...(req.query.yearFrom ? { gte: parseInt(req.query.yearFrom) } : {}),
          ...(req.query.yearTo   ? { lte: parseInt(req.query.yearTo)   } : {}),
        }
      } : {}),
      ...(genreFilter),
      // Tag filter — same pattern as genre, checks if the tags array contains the value
      ...(req.query.tag ? { tags: { has: req.query.tag } } : {}),
      ...(textFilter),
      ...(personFilter),
      ...(excludeReviewed && reviewedIds.length && { id: { notIn: reviewedIds } }),
      // If reviewedBy is set, restrict to items that user has reviewed
      ...(reviewedByIds !== undefined && { id: { in: reviewedByIds.length ? reviewedByIds : ['__none__'] } }),
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
          directors: { select: { id: true, name: true, slug: true }, take: 100 },
          authors:   { select: { id: true, name: true, slug: true }, take: 100 },
          cast:      { select: { id: true, name: true, slug: true }, take: 100 },
          // Include parent show info so season entries can display their show name
          // and so the frontend can identify seasons vs parent shows
          parent:    { select: { id: true, title: true, slug: true } },
        },
        orderBy,
        skip: (parseInt(page) - 1) * take,
        take,
      }),
      prisma.mediaItem.count({ where }),
    ]);

    // Compute avg rating per item
    const itemIds = items.map(i => i.id);
    const ratings = await prisma.review.groupBy({
      by: ['mediaItemId'],
      where: { mediaItemId: { in: itemIds }, visibility: 'PUBLIC' },
      _avg: { rating: true },
    });
    const ratingMap = Object.fromEntries(ratings.map(r => [r.mediaItemId, r._avg.rating]));

    res.json({
      items: items.map(i => ({
        ...i,
        avgRating: ratingMap[i.id] || null,
        // If filtering by reviewedBy, include that user's personal rating on each item
        // so the search page can show "Marco rated this 8/10" alongside community avg
        reviewedByRating: req.reviewedByRatings?.[i.id] || null,
      })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / take),
    });
  } catch (err) { next(err); }
});

// ─── GET /api/media/:slug ─────────────────────────────────────────────────
router.get('/:slug', optionalAuth, async (req, res, next) => {
  try {
    const item = await prisma.mediaItem.findUnique({
      where: { slug: req.params.slug },
      include: {
        directors: { select: { id: true, name: true, slug: true, imageUrl: true }, take: 100 },
        cast:       { select: { id: true, name: true, slug: true, imageUrl: true }, take: 100 },
        authors:    { select: { id: true, name: true, slug: true, imageUrl: true }, take: 100 },
        _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
        // Include parent so seasons can show parent show info and inherit cast
        parent: {
          select: { id: true, title: true, slug: true },
          include: {
            cast: { select: { id: true, name: true, slug: true, imageUrl: true }, take: 100 },
          },
        },
      },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });

    // For TV seasons, merge parent show cast with season-specific cast.
    // Parent cast = main series regulars, season cast = additional/guest cast.
    // Combined and deduplicated so no one appears twice.
    if (item.parentId && item.parent?.cast?.length) {
      const seasonCastIds  = new Set((item.cast || []).map(p => p.id));
      const parentOnlyCast = item.parent.cast.filter(p => !seasonCastIds.has(p.id));
      item.cast = [...(item.cast || []), ...parentOnlyCast];
    }

    const stats = await prisma.review.aggregate({
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      _avg: { rating: true }, _count: { rating: true },
    });

    const verdicts = await prisma.review.groupBy({
      by: ['verdict'],
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      _count: { verdict: true },
    });

    let userReview = null;
    if (req.user) {
      userReview = await prisma.review.findFirst({
        where: { userId: req.user.id, mediaItemId: item.id, seasonNumber: null },
      });
    }

    // Sort cast, directors, authors alphabetically in JS — Prisma doesn't support
    // orderBy on implicit many-to-many relations, so we sort after fetching
    const sortByName = (a, b) => a.name.localeCompare(b.name);
    if (item.cast)      item.cast      = item.cast.sort(sortByName);
    if (item.directors) item.directors = item.directors.sort(sortByName);
    if (item.authors)   item.authors   = item.authors.sort(sortByName);

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
router.get('/:slug/reviews', optionalAuth, async (req, res, next) => {
  try {
    const item = await prisma.mediaItem.findUnique({ where: { slug: req.params.slug } });
    if (!item) return res.status(404).json({ error: 'Not found' });
    const page = parseInt(req.query.page) || 1;
    const take = 20;
    const seasonFilter = req.query.season ? { seasonNumber: parseInt(req.query.season) } : {};
    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where: { mediaItemId: item.id, visibility: 'PUBLIC', ...seasonFilter },
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          // Include reactions with userId so we can compute myReaction for the logged-in user
          reactions: { select: { userId: true, emoji: true } },
          _count: { select: { reactions: true, comments: true } },
        },
        orderBy: req.query.sort === 'top' ? [{ reactions: { _count: 'desc' } }] : [{ createdAt: 'desc' }],
        skip: (page - 1) * take, take,
      }),
      prisma.review.count({ where: { mediaItemId: item.id, visibility: 'PUBLIC', ...seasonFilter } }),
    ]);
    // Enrich each review with the current user's reaction (if logged in)
    const enriched = reviews.map(r => ({
      ...r,
      myReaction: req.user
        ? (r.reactions.find(rx => rx.userId === req.user.id)?.emoji || null)
        : null,
      // Keep _count accurate regardless
    }));

    res.json({ reviews: enriched, total, page, pages: Math.ceil(total / take) });
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
