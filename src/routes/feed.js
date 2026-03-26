// src/routes/feed.js
const router = require('express').Router();
const { query } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');

// ─── GET /api/feed ─── Friend activity + timeframe support ──────────────
router.get('/', requireAuth, [
  query('page').optional().isInt({ min: 1 }),
  query('mediaType').optional().isIn(['MOVIE','BOOK','TV_SHOW','BOARD_GAME','VIDEO_GAME']),
  query('mode').optional().isIn(['friends', 'all', 'trending']),
  query('days').optional().isInt({ min: 1 }),
], async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = 20;
    const mode = req.query.mode || 'friends';

    // Get admin-set timeframe if not explicitly passed
    let days = req.query.days ? parseInt(req.query.days) : null;
    if (!days && mode === 'trending') {
      const setting = await prisma.adminSetting.findUnique({ where: { key: 'feedTimeframeDays' } });
      days = setting ? parseInt(setting.value) : 30;
    }

    // Get friend IDs
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

    // Build author filter based on mode
    let authorIds;
    if (mode === 'friends') {
      authorIds = [req.user.id, ...friendIds];
    } else {
      authorIds = undefined; // all users
    }

    // Build date filter
    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;

    const where = {
      ...(authorIds && { userId: { in: authorIds } }),
      visibility: authorIds ? { in: ['PUBLIC', 'FRIENDS_ONLY'] } : 'PUBLIC',
      ...(req.query.mediaType && { mediaItem: { mediaType: req.query.mediaType } }),
      ...(since && { createdAt: { gte: since } }),
    };

    const orderBy = mode === 'trending'
      ? [{ reactions: { _count: 'desc' } }, { createdAt: 'desc' }]
      : [{ createdAt: 'desc' }];

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          mediaItem: {
            select: {
              id: true, title: true, slug: true, mediaType: true, releaseYear: true,
              imageUrl: true, genres: true, tags: true,
              tmdbRating: true, openCriticScore: true,
            },
          },
          reactions: { select: { userId: true, emoji: true } },
          _count: { select: { reactions: true, comments: true } },
          // dateConsumed and all other scalar review fields are included automatically
        },
        orderBy,
        skip: (page - 1) * take,
        take,
      }),
      prisma.review.count({ where }),
    ]);

    const enriched = reviews.map(r => ({
      ...r,
      myReaction: r.reactions.find(rx => rx.userId === req.user.id)?.emoji || null,
      reactionSummary: r.reactions.reduce((acc, { emoji }) => {
        acc[emoji] = (acc[emoji] || 0) + 1; return acc;
      }, {}),
    }));

    // Get admin timeframe setting for client
    const setting = await prisma.adminSetting.findUnique({ where: { key: 'feedTimeframeDays' } });

    res.json({
      reviews: enriched, total, page,
      pages: Math.ceil(total / take),
      friendCount: friendIds.length,
      adminTimeframeDays: setting ? parseInt(setting.value) : null,
    });
  } catch (err) { next(err); }
});

// ─── GET /api/feed/trending ───────────────────────────────────────────────
router.get('/trending', optionalAuth, async (req, res, next) => {
  try {
    const setting = await prisma.adminSetting.findUnique({ where: { key: 'feedTimeframeDays' } });
    const days = setting ? parseInt(setting.value) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // If logged in, weight towards friend activity; otherwise show global trending
    let authorIds;
    if (req.user) {
      const friendships = await prisma.friendship.findMany({
        where: { status: 'ACCEPTED', OR: [{ initiatorId: req.user.id }, { receiverId: req.user.id }] },
        select: { initiatorId: true, receiverId: true },
      });
      const friendIds = friendships.map(f => f.initiatorId === req.user.id ? f.receiverId : f.initiatorId);
      authorIds = friendIds.length ? [req.user.id, ...friendIds] : undefined;
    }

    const trending = await prisma.review.groupBy({
      by: ['mediaItemId'],
      where: {
        ...(authorIds ? { userId: { in: authorIds } } : {}),
        visibility: 'PUBLIC',
        createdAt: { gte: since },
      },
      _count: { mediaItemId: true },
      _avg: { rating: true },
      orderBy: { _count: { mediaItemId: 'desc' } },
      take: 10,
    });

    const mediaItems = await prisma.mediaItem.findMany({
      where: { id: { in: trending.map(t => t.mediaItemId) } },
      select: { id: true, title: true, slug: true, mediaType: true, releaseYear: true, imageUrl: true },
    });

    res.json(trending.map(t => ({
      ...mediaItems.find(m => m.id === t.mediaItemId),
      reviewCount: t._count.mediaItemId,  // expose as reviewCount so frontend can use it
      avgRating:   t._avg.rating,
    })));
  } catch (err) { next(err); }
});

// ─── GET /api/feed/notifications ─────────────────────────────────────────
router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      prisma.notification.count({ where: { userId: req.user.id, read: false } }),
    ]);
    res.json({ notifications, unreadCount });
  } catch (err) { next(err); }
});

router.post('/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data: { read: true },
    });
    res.json({ message: 'All notifications marked read' });
  } catch (err) { next(err); }
});

module.exports = router;
