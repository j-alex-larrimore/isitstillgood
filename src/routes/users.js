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

// ─── GET /api/users/:username ─── Public profile ──────────────────────────
router.get('/:username', optionalAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { username: req.params.username },
      select: {
        id: true, username: true, displayName: true, avatarUrl: true,
        bio: true, createdAt: true, profilePublic: true,
        _count: {
          select: {
            reviews: { where: { visibility: 'PUBLIC' } },
            friendsInitiated: { where: { status: 'ACCEPTED' } },
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Private profile — only the owner or friends can see
    const isSelf = req.user?.id === user.id;
    if (!user.profilePublic && !isSelf) {
      // Check if they're friends
      if (req.user) {
        const friendship = await prisma.friendship.findFirst({
          where: {
            status: 'ACCEPTED',
            OR: [
              { initiatorId: req.user.id, receiverId: user.id },
              { initiatorId: user.id, receiverId: req.user.id },
            ],
          },
        });
        if (!friendship) return res.status(403).json({ error: 'This profile is private' });
      } else {
        return res.status(403).json({ error: 'This profile is private' });
      }
    }

    res.json(user);
  } catch (err) { next(err); }
});

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
  query('mediaType').optional().isIn(['MOVIE', 'BOOK', 'TV_SHOW', 'BOARD_GAME', 'VIDEO_GAME']),
], async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    const isSelf = req.user?.id === target.id;
    const page   = parseInt(req.query.page) || 1;
    const take   = 20;

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

    const where = {
      userId: target.id,
      visibility: visibilityFilter,
      ...(req.query.mediaType && { mediaItem: { mediaType: req.query.mediaType } }),
    };

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          mediaItem: {
            select: {
              id: true, title: true, mediaType: true, releaseYear: true,
              imageUrl: true, slug: true, genres: true,
              imdbRating: true, rtScore: true, goodreadsRating: true,
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

module.exports = router;
