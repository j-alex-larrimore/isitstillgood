// src/routes/feed.js
const router = require('express').Router();
const { query } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { clusterBookSeries, pickSeriesRepresentative } = require('../lib/mediaHelpers');

// ─── GET /api/feed ─── Friend activity + timeframe support ──────────────
// optionalAuth (not requireAuth) — logged-out visitors can load mode=all/
// trending too, so the homepage always shows real reviews instead of
// falling back to a raw, unreviewed catalog browse (see index.html's
// loadFeed, which used to special-case the logged-out path this way).
// mode=friends with no req.user just returns an empty feed below.
router.get('/', optionalAuth, [
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

    // Get friend IDs (only meaningful when logged in)
    const friendships = req.user ? await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ initiatorId: req.user.id }, { receiverId: req.user.id }],
      },
      select: { initiatorId: true, receiverId: true },
    }) : [];
    const friendIds = friendships.map(f =>
      f.initiatorId === req.user.id ? f.receiverId : f.initiatorId
    );

    // Build author filter based on mode
    let authorIds;
    if (mode === 'friends') {
      // Friends feed shows only friends, not the current user's own reviews
      // (user's own reviews appear under Everyone). No req.user (logged out)
      // or no friends both fall through to an empty result.
      authorIds = friendIds.length ? friendIds : ['__none__'];
    } else {
      authorIds = undefined; // all users
    }

    // Build date filter
    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;

    const where = {
      ...(authorIds && { userId: { in: authorIds } }),
      visibility: authorIds ? { in: ['PUBLIC', 'FRIENDS_ONLY'] } : 'PUBLIC',
      // mediaItem.verified:true guards against a review somehow existing on an
      // item still awaiting admin approval — shouldn't normally happen since
      // unverified items aren't reachable to review in the first place.
      mediaItem: {
        verified: true,
        ...(req.query.mediaType && { mediaType: req.query.mediaType }),
      },
      ...(since && { updatedAt: { gte: since } }),
    };

    // Sort by most recently created or edited — edits always bubble to the top
    const orderBy = mode === 'trending'
      ? [{ reactions: { _count: 'desc' } }, { updatedAt: 'desc' }]
      : [{ updatedAt: 'desc' }];

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
              seriesName: true, seriesNumber: true, authors: { select: { id: true } },
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

    // A review of a book that's its series' representative (see Browse's own
    // "collapse into one series card" convention) should read the same way
    // here — "The Tarot Sequence", not the representative's own title "Last
    // Sun" — confirmed live: a review of Last Sun showed as a review of
    // "Last Sun" in the feed even though Browse presents that exact book as
    // the whole series' card. Only the representative gets this treatment;
    // a review of any other book in the series still shows its own title,
    // since that's a review of that specific book, not the series overall.
    const seriesNames = [...new Set(
      reviews.filter(r => r.mediaItem.mediaType === 'BOOK' && r.mediaItem.seriesName).map(r => r.mediaItem.seriesName)
    )];
    const seriesRepIds = new Set();
    if (seriesNames.length) {
      const seriesBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: { in: seriesNames } },
        select: { id: true, seriesName: true, seriesNumber: true, authors: { select: { id: true } } },
      });
      for (const cluster of clusterBookSeries(seriesBooks)) {
        seriesRepIds.add(pickSeriesRepresentative(cluster.books).id);
      }
    }

    const enriched = reviews.map(r => ({
      ...r,
      mediaItem: {
        ...r.mediaItem,
        displayTitle: (r.mediaItem.mediaType === 'BOOK' && seriesRepIds.has(r.mediaItem.id))
          ? r.mediaItem.seriesName
          : undefined,
      },
      myReaction: req.user ? (r.reactions.find(rx => rx.userId === req.user.id)?.emoji || null) : null,
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

// Simple in-memory cache for trending (unauthenticated) — avoids timeout on cold requests
let trendingCache = null;
let trendingCacheTime = 0;
const TRENDING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── GET /api/feed/trending ───────────────────────────────────────────────
router.get('/trending', optionalAuth, async (req, res, next) => {
  try {
    // Serve cached response for unauthenticated requests to avoid timeout
    if (!req.user && trendingCache && Date.now() - trendingCacheTime < TRENDING_CACHE_TTL) {
      return res.json(trendingCache);
    }

    // Fetch setting and friendships in parallel
    const [setting, friendships] = await Promise.all([
      prisma.adminSetting.findUnique({ where: { key: 'feedTimeframeDays' } }),
      req.user ? prisma.friendship.findMany({
        where: { status: 'ACCEPTED', OR: [{ initiatorId: req.user.id }, { receiverId: req.user.id }] },
        select: { initiatorId: true, receiverId: true },
      }) : Promise.resolve([]),
    ]);

    const days = setting ? parseInt(setting.value) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    let authorIds;
    if (req.user && friendships.length) {
      const friendIds = friendships.map(f => f.initiatorId === req.user.id ? f.receiverId : f.initiatorId);
      authorIds = friendIds.length ? [req.user.id, ...friendIds] : undefined;
    }

    // Wrap in a race so the endpoint never hangs longer than 5s
    const trending = await Promise.race([
      prisma.review.groupBy({
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
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);

    const mediaItems = await prisma.mediaItem.findMany({
      where: { id: { in: trending.map(t => t.mediaItemId) }, verified: true },
      select: { id: true, title: true, slug: true, mediaType: true, releaseYear: true, imageUrl: true },
    });

    const result = trending
      .map(t => {
        const media = mediaItems.find(m => m.id === t.mediaItemId);
        if (!media) return null; // filtered out by verified:true above
        return { ...media, reviewCount: t._count.mediaItemId, avgRating: t._avg.rating };
      })
      .filter(Boolean);

    if (!req.user) {
      trendingCache = result;
      trendingCacheTime = Date.now();
    }

    res.json(result);
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
