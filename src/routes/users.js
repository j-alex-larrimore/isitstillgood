// src/routes/users.js
const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const prisma  = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

// ─── PATCH /api/users/me ─── Update own profile ────────────────────────────
router.patch('/me', requireAuth, [
  body('displayName').optional().trim().isLength({ min: 1, max: 60 }),
  body('bio').optional().trim().isLength({ max: 500 }),
  body('profilePublic').optional().isBoolean(),
  body('defaultVisibility').optional().isIn(['PUBLIC', 'FRIENDS_ONLY', 'PRIVATE']),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  const { displayName, bio, profilePublic, defaultVisibility } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { displayName, bio, profilePublic, defaultVisibility },
      select: { id: true, username: true, displayName: true, bio: true, avatarUrl: true, profilePublic: true, defaultVisibility: true },
    });
    res.json(user);
  } catch (err) { next(err); }
});

// ─── GET /api/users/:username/reviews ─── Their review timeline ────────────
router.get('/:username/reviews', optionalAuth, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 20 }),
  query('rating').optional().isInt({ min: 1, max: 10 }),
  query('type').optional().isIn(['MOVIE', 'BOOK', 'TV_SHOW', 'BOARD_GAME', 'VIDEO_GAME']),
  query('mediaType').optional().isIn(['MOVIE', 'BOOK', 'TV_SHOW', 'BOARD_GAME', 'VIDEO_GAME']),
], async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    const isSelf = req.user?.id === target.id;
    const page   = parseInt(req.query.page) || 1;
    const take   = parseInt(req.query.limit) || 20;

    // Determine which visibility levels the requester can see
    let visibilityFilter;
    if (isSelf) {
      visibilityFilter = { in: ['PUBLIC', 'FRIENDS_ONLY', 'PRIVATE'] };
    } else {
      // Check friendship
      const areFriends = req.user && await prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { initiatorId: req.user.id, receiverId: target.id },
            { initiatorId: target.id, receiverId: req.user.id },
          ],
        },
      });
      visibilityFilter = areFriends ? { in: ['PUBLIC', 'FRIENDS_ONLY'] } : { equals: 'PUBLIC' };
    }

    // Support both ?type= and ?mediaType= for media type filtering
    const typeFilter = req.query.type || req.query.mediaType;
    const where = {
      userId: target.id,
      visibility: visibilityFilter,
      ...(req.query.rating && { rating: parseInt(req.query.rating) }),
      ...(typeFilter && { mediaItem: { mediaType: typeFilter } }),
    };

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          mediaItem: {
            select: {
              id: true, title: true, mediaType: true, releaseYear: true,
              imageUrl: true, slug: true, genres: true,
              tmdbRating: true, openCriticScore: true,
            },
          },
          _count: { select: { reactions: true, comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take,
        take,
      }),
      prisma.review.count({ where }),
    ]);

    res.json({ reviews, total, page, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// ─── GET /api/users/search?q= ─── Find users by username, name, or email ──
// Email search lets existing users find each other even if they don't know
// each other's username. We search email but never expose it in the results —
// the response only returns public profile fields.
router.get('/search', requireAuth, [
  query('q').trim().isLength({ min: 2 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          // Search by username (partial match, case-insensitive)
          { username:    { contains: req.query.q, mode: 'insensitive' } },
          // Search by display name
          { displayName: { contains: req.query.q, mode: 'insensitive' } },
          // Search by email — allows finding friends who haven't set a username yet
          // or when you only know someone's email address
          { email:       { contains: req.query.q, mode: 'insensitive' } },
        ],
        // Never return the searching user in their own results
        NOT: { id: req.user.id },
      },
      // Only return public-safe fields — never return passwordHash, googleId, etc.
      // We intentionally omit email from results to protect user privacy;
      // the search matches on email but doesn't reveal it
      select: { id: true, username: true, displayName: true, avatarUrl: true },
      take: 20,
    });
    res.json(users);
  } catch (err) { next(err); }
});




// ─── GET /api/users/:username ─── Public profile ─────────────────────────────
// Returns a user's public profile including their recent reviews and stats.
// Visibility rules:
//   - profilePublic = true  → anyone can view
//   - profilePublic = false → only the user themselves and accepted friends
router.get('/:username', optionalAuth, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({
      where: { username: req.params.username },
      select: {
        id: true, username: true, displayName: true,
        bio: true, avatarUrl: true, profilePublic: true,
        createdAt: true, email: true,
        // Count total reviews for the stats section
        _count: { select: { reviews: true } },
      },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    const isSelf = req.user?.id === target.id;

    // Check if the viewer is allowed to see this profile
    let canView = target.profilePublic || isSelf;
    if (!canView && req.user) {
      // Check if they are accepted friends
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { initiatorId: req.user.id, receiverId: target.id },
            { initiatorId: target.id,   receiverId: req.user.id },
          ],
        },
      });
      if (friendship) canView = true;
    }

    if (!canView) {
      // Return minimal info so the page can show a "friends only" message
      return res.status(403).json({
        error: 'friends_only',
        displayName: target.displayName,
        username: target.username,
      });
    }

    // Fetch recent reviews with media item details
    const reviews = await prisma.review.findMany({
      where: {
        userId: target.id,
        // Self can see all; others only see public/friends reviews
        visibility: isSelf ? undefined : { in: ['PUBLIC', 'FRIENDS_ONLY'] },
      },
      include: {
        mediaItem: {
          select: {
            id: true, title: true, slug: true, mediaType: true,
            releaseYear: true, imageUrl: true, genres: true,
          },
        },
        _count: { select: { reactions: true, comments: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // Compute aggregate stats
    const stats = await prisma.review.aggregate({
      where: { userId: target.id },
      _avg: { rating: true },
      _count: { rating: true },
    });

    // Verdict breakdown — how many TIMELESS, STILL_GOOD etc.
    const verdicts = await prisma.review.groupBy({
      by: ['verdict'],
      where: { userId: target.id },
      _count: { verdict: true },
    });

    res.json({
      user: {
        ...target,
        // Only expose email to the profile owner
        email: isSelf ? target.email : undefined,
      },
      isSelf,
      reviews,
      stats: {
        totalReviews:  stats._count.rating,
        avgRating:     stats._avg.rating,
        verdictCounts: Object.fromEntries(verdicts.map(v => [v.verdict, v._count.verdict])),
      },
    });
  } catch (err) { next(err); }
});

// ─── PATCH /api/users/me/settings ─── Update profile visibility ───────────────
// Allows the logged-in user to toggle profilePublic and update their bio.
router.patch('/me/settings', requireAuth, [
  body('profilePublic').optional().isBoolean(),
  body('bio').optional().trim().isLength({ max: 500 }),
  body('displayName').optional().trim().isLength({ min: 1, max: 100 }),
  body('email').optional().trim().isEmail().withMessage('Must be a valid email address'),
], async (req, res, next) => {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(422).json({ errors: e.array() });
  try {
    const data = {};
    if (req.body.profilePublic !== undefined) data.profilePublic = req.body.profilePublic;
    if (req.body.bio !== undefined)           data.bio           = req.body.bio;
    if (req.body.displayName !== undefined)   data.displayName   = req.body.displayName;
    if (req.body.email !== undefined) {
      // Check email isn't already taken by another user
      const existing = await prisma.user.findFirst({
        where: { email: req.body.email, NOT: { id: req.user.id } },
      });
      if (existing) return res.status(409).json({ error: 'Email already in use by another account' });
      data.email = req.body.email.toLowerCase();
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true, username: true, displayName: true,
        bio: true, profilePublic: true, email: true,
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// ─── GET /api/users/:username/taste-profile ───────────────────────────────────
// Computes a user's "taste profile" — their favorite directors, actors, authors,
// and genres based on their review history.
//
// Rules:
//   - Only considers PUBLIC and FRIENDS_ONLY reviews
//   - A person or genre must appear in at least 2 reviewed items to qualify
//   - Ranked by the user's average rating across those items (not community avg)
//   - Returns top 5 per category
//
// Visibility: respects the user's profilePublic setting.
// Friends can always see it; public visitors only if profilePublic = true.
router.get('/:username/taste-profile', optionalAuth, async (req, res, next) => {
  try {
    // Look up the target user
    const target = await prisma.user.findUnique({
      where: { username: req.params.username },
      select: { id: true, username: true, displayName: true, profilePublic: true },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    const isSelf = req.user?.id === target.id;

    // Check visibility — friends-only profile requires friendship
    if (!target.profilePublic && !isSelf) {
      if (!req.user) return res.status(403).json({ error: 'This profile is private' });
      const areFriends = await prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { initiatorId: req.user.id, receiverId: target.id },
            { initiatorId: target.id,   receiverId: req.user.id },
          ],
        },
      });
      if (!areFriends) return res.status(403).json({ error: 'This profile is friends only' });
    }

    // Fetch all of this user's public/friends reviews with media item details
    // We need the full cast/directors/authors/genres to compute the taste profile
    const reviews = await prisma.review.findMany({
      where: {
        userId: target.id,
        visibility: { in: ['PUBLIC', 'FRIENDS_ONLY'] },
      },
      select: {
        rating: true,
        mediaItem: {
          select: {
            mediaType: true,
            genres: true,
            // Relations — we need names of people associated with each item
            directors: { select: { id: true, name: true, slug: true } },
            cast:      { select: { id: true, name: true, slug: true } },
            authors:   { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });

    // ── Helper: build a ranked list from person/genre occurrences ─────────────
    // Takes a map of { id/name -> { name, slug?, ratings: [] } }
    // Returns array sorted by avgRating desc, filtered to min 2 entries
    function rankEntries(map, minCount = 1, topN = 3) {
      return Object.values(map)
        .filter(entry => entry.ratings.length >= minCount)
        .map(entry => ({
          name:     entry.name,
          slug:     entry.slug || null,
          count:    entry.ratings.length,
          avgRating: entry.ratings.reduce((a, b) => a + b, 0) / entry.ratings.length,
        }))
        .sort((a, b) => b.avgRating - a.avgRating || b.count - a.count)
        .slice(0, topN);
    }

    // ── Accumulate ratings per director, actor, author, genre — split by media type ──
    // We track per-type counts so we can apply a dynamic threshold:
    // to qualify as "favorite", a genre/person must appear in at least
    // 1/10th of all reviews in that type (min 1), making the bar proportional.
    const directors = {}, actors = {}, authors = {}, genres = {};
    const countByType = {}; // total reviews per media type

    for (const review of reviews) {
      const item   = review.mediaItem;
      const rating = review.rating;
      const type   = item.mediaType;

      countByType[type] = (countByType[type] || 0) + 1;

      for (const p of (item.directors || [])) {
        if (!directors[p.id]) directors[p.id] = { name: p.name, slug: p.slug, ratings: [], types: {} };
        directors[p.id].ratings.push(rating);
        directors[p.id].types[type] = (directors[p.id].types[type] || 0) + 1;
      }
      for (const p of (item.cast || [])) {
        if (!actors[p.id]) actors[p.id] = { name: p.name, slug: p.slug, ratings: [], types: {} };
        actors[p.id].ratings.push(rating);
        actors[p.id].types[type] = (actors[p.id].types[type] || 0) + 1;
      }
      for (const p of (item.authors || [])) {
        if (!authors[p.id]) authors[p.id] = { name: p.name, slug: p.slug, ratings: [], types: {} };
        authors[p.id].ratings.push(rating);
        authors[p.id].types[type] = (authors[p.id].types[type] || 0) + 1;
      }
      for (const g of (item.genres || [])) {
        if (!genres[g]) genres[g] = { name: g, ratings: [], types: {} };
        genres[g].ratings.push(rating);
        genres[g].types[type] = (genres[g].types[type] || 0) + 1;
      }
    }

    // Dynamic threshold: at least 1/10th of reviews in that type, minimum 1
    function threshold(typeCount) {
      return Math.max(1, Math.floor(typeCount / 10));
    }

    // ── Build per-media-type genre breakdowns with dynamic thresholds ──────────
    const genresByType = {};
    for (const review of reviews) {
      const type = review.mediaItem.mediaType;
      if (!genresByType[type]) genresByType[type] = {};
      for (const g of (review.mediaItem.genres || [])) {
        if (!genresByType[type][g]) genresByType[type][g] = { name: g, ratings: [] };
        genresByType[type][g].ratings.push(review.rating);
      }
    }
    const favoriteGenreByType = {};
    const mostReviewedGenreByType = {};
    for (const [type, gMap] of Object.entries(genresByType)) {
      const minCount = threshold(countByType[type] || 0);
      const byRating = rankEntries(gMap, minCount, 3);
      const byCount  = rankByCount(gMap, minCount, 3);
      if (byRating.length) favoriteGenreByType[type]     = byRating;
      if (byCount.length)  mostReviewedGenreByType[type] = byCount;
    }

    // Overall person thresholds — use total review count / 10
    const totalThreshold = threshold(reviews.length);

    // ── Most reviewed variants — same data, sorted by count not avgRating ───────
    function rankByCount(map, minCount = 1, topN = 3) {
      return Object.values(map)
        .filter(entry => entry.ratings.length >= minCount)
        .map(entry => ({
          name:      entry.name,
          slug:      entry.slug || null,
          count:     entry.ratings.length,
          avgRating: entry.ratings.reduce((a, b) => a + b, 0) / entry.ratings.length,
        }))
        .sort((a, b) => b.count - a.count || b.avgRating - a.avgRating)
        .slice(0, topN);
    }

    res.json({
      totalReviews:       reviews.length,
      favoriteDirectors:  rankEntries(directors),
      favoriteActors:     rankEntries(actors),
      favoriteAuthors:    rankEntries(authors),
      favoriteGenres:     rankEntries(genres),
      favoriteGenreByType,
      mostReviewedDirectors: rankByCount(directors),
      mostReviewedActors:    rankByCount(actors),
      mostReviewedAuthors:   rankByCount(authors),
      mostReviewedGenres:    rankByCount(genres),
    });
  } catch (err) { next(err); }
});

module.exports = router;
