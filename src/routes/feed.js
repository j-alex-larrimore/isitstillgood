// src/routes/feed.js
const router = require('express').Router();
const { query } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

// ─── GET /api/feed ─── Paginated friend activity feed ───────────────────
router.get('/', requireAuth, [
  query('page').optional().isInt({ min: 1 }),
  query('mediaType').optional().isIn(['MOVIE','BOOK','TV_SHOW','BOARD_GAME','VIDEO_GAME']),
], async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = 20;

    // Get all accepted friends
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ initiatorId: req.user.id }, { receiverId: req.user.id }],
      },
      select: { initiatorId: true, receiverId: true },
    });

    const friendIds = friendships.map(f =>
      f.initiatorId === req.user.id ? f.receiverId : f.initiatorId
    );

    // Include own reviews in feed too
    const authorIds = [req.user.id, ...friendIds];

    const where = {
      userId: { in: authorIds },
      visibility: { in: ['PUBLIC', 'FRIENDS_ONLY'] },
      ...(req.query.mediaType && { mediaItem: { mediaType: req.query.mediaType } }),
    };

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          mediaItem: {
            select: {
              id: true, title: true, slug: true, mediaType: true, releaseYear: true,
              imageUrl: true, genres: true, imdbRating: true, rtScore: true,
              goodreadsRating: true, openCriticScore: true,
            },
          },
          reactions: {
            select: { userId: true, emoji: true },
          },
          _count: { select: { reactions: true, comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take,
        take,
      }),
      prisma.review.count({ where }),
    ]);

    // Annotate each review with whether the current user has reacted
    const enriched = reviews.map(r => ({
      ...r,
      myReaction: r.reactions.find(rx => rx.userId === req.user.id)?.emoji || null,
      reactionSummary: summarizeReactions(r.reactions),
    }));

    res.json({
      reviews: enriched,
      total,
      page,
      pages: Math.ceil(total / take),
      friendCount: friendIds.length,
    });
  } catch (err) { next(err); }
});

// ─── GET /api/feed/notifications ────────────────────────────────────────
router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      prisma.notification.count({
        where: { userId: req.user.id, read: false },
      }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (err) { next(err); }
});

// ─── POST /api/feed/notifications/read-all ───────────────────────────────
router.post('/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data: { read: true },
    });
    res.json({ message: 'All notifications marked read' });
  } catch (err) { next(err); }
});

// ─── GET /api/feed/trending ─── What's popular among friends ────────────
router.get('/trending', requireAuth, async (req, res, next) => {
  try {
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ initiatorId: req.user.id }, { receiverId: req.user.id }],
      },
      select: { initiatorId: true, receiverId: true },
    });

    const friendIds = friendships.map(f =>
      f.initiatorId === req.user.id ? f.receiverId : f.initiatorId
    );

    if (!friendIds.length) return res.json([]);

    // Top reviewed items by friends in the last 30 days
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const trending = await prisma.review.groupBy({
      by: ['mediaItemId'],
      where: {
        userId: { in: friendIds },
        visibility: { in: ['PUBLIC', 'FRIENDS_ONLY'] },
        createdAt: { gte: since },
      },
      _count: { mediaItemId: true },
      _avg: { rating: true },
      orderBy: { _count: { mediaItemId: 'desc' } },
      take: 10,
    });

    const mediaItems = await prisma.mediaItem.findMany({
      where: { id: { in: trending.map(t => t.mediaItemId) } },
      select: {
        id: true, title: true, slug: true, mediaType: true,
        releaseYear: true, imageUrl: true, genres: true,
      },
    });

    const result = trending.map(t => ({
      ...t,
      mediaItem: mediaItems.find(m => m.id === t.mediaItemId),
    }));

    res.json(result);
  } catch (err) { next(err); }
});

// ─── Helper ───────────────────────────────────────────────────────────────
function summarizeReactions(reactions) {
  return reactions.reduce((acc, { emoji }) => {
    acc[emoji] = (acc[emoji] || 0) + 1;
    return acc;
  }, {});
}

module.exports = router;
