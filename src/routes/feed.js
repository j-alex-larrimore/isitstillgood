// src/routes/feed.js
const router = require('express').Router();
const { query } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { buildSeriesRepMap } = require('../lib/mediaHelpers');

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

    // Everyone/trending only: don't surface reviews written by someone whose
    // profile the viewer couldn't open anyway — clicking through to a private
    // author just hits the lock screen, and their writing shouldn't be public
    // reading when their profile isn't. Mirrors the rule in users.js's
    // GET /:username exactly: a profile is viewable when it's public, your
    // own, or a friend's. The friends feed needs no such filter — everyone in
    // it is by definition a friend, so their profile is already open to you.
    const authorVisible = authorIds ? null : {
      OR: [
        { user: { profilePublic: true } },
        // Your own reviews stay in your Everyone feed even while your profile
        // is private, and a private friend stays visible to their friends —
        // neither is a disclosure to anyone who couldn't already look.
        ...(req.user ? [{ userId: req.user.id }, { userId: { in: friendIds } }] : []),
      ],
    };

    const where = {
      ...(authorIds && { userId: { in: authorIds } }),
      visibility: authorIds ? { in: ['PUBLIC', 'FRIENDS_ONLY'] } : 'PUBLIC',
      ...(authorVisible && { AND: [authorVisible] }),
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
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true, avatarEmoji: true } },
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

    // A book review reads as the SERIES only when it's a series-level review
    // (the seasonNumber:0 sentinel) — a verdict on the series as a whole.
    // This used to key off "is this book its series' representative?"
    // instead, which relabeled an ordinary review of book 1 with the series
    // name while the card still linked to that one book, so the title and
    // the destination disagreed (73 such reviews live). A review of a
    // specific book is a review of that book, whichever number it is.
    //
    // Series-level reviews are written against whatever book represented the
    // series at the time, so they go stale when an earlier-numbered
    // prequel/novella is added later. Resolve to the CURRENT representative
    // for title, cover and link — the same staleness users.js already
    // corrects for taste profiles. Confirmed live: a "The Wheel of Time"
    // series review sits on "New Spring" (#0) and surfaced here as a review
    // of New Spring, showing the prequel's cover instead of book 1's.
    const repByBookId = await buildSeriesRepMap(reviews.map(r => r.mediaItem));

    // The viewer's OWN rating of each media item shown, regardless of whose
    // review the card displays — index.html's "+ Log mine" action used to
    // show on every friend's review, even ones you'd already reviewed
    // yourself (through your own separate review row on the same item),
    // since it only ever checked whether THIS card's review belonged to
    // you. Confirmed live: a friend's review of a movie you'd already rated
    // still said "+ Log mine" instead of showing your existing rating.
    // seasonNumber !== 0 (an individual review) wins over a whole-series
    // verdict on the rare item that has both — the feed always shows one
    // specific item, same reasoning as Browse's individual-item view (see
    // buildUserRatingsMap's individualBookMode in media.js).
    const myRatingByItem = {};
    if (req.user) {
      const itemIds = [...new Set(reviews.map(r => r.mediaItemId))];
      const myOwnReviews = await prisma.review.findMany({
        where: { userId: req.user.id, mediaItemId: { in: itemIds } },
        select: { mediaItemId: true, rating: true, seasonNumber: true },
      });
      for (const r of myOwnReviews) {
        if (myRatingByItem[r.mediaItemId] == null || r.seasonNumber !== 0) {
          myRatingByItem[r.mediaItemId] = r.rating;
        }
      }
    }

    const enriched = reviews.map(r => {
      const isBookSeriesReview =
        r.mediaItem.mediaType === 'BOOK' && !!r.mediaItem.seriesName && r.seasonNumber === 0;
      // Only the display/link fields move to the representative — `id` stays
      // the reviewed row's own, since myRatingByItem and the reaction
      // handlers below are keyed off the actual review target.
      const rep = isBookSeriesReview ? repByBookId.get(r.mediaItem.id) : null;
      return {
        ...r,
        mediaItem: {
          ...r.mediaItem,
          ...(rep ? {
            title: rep.title, slug: rep.slug,
            imageUrl: rep.imageUrl, releaseYear: rep.releaseYear,
            // seriesNumber travels with the rest, or the payload would pair
            // book 1's title with the superseded host row's number.
            seriesNumber: rep.seriesNumber,
          } : {}),
          displayTitle: isBookSeriesReview ? r.mediaItem.seriesName : undefined,
          // Lets the client link to the series page instead of appending
          // ?book=1 for an individual book (see renderReviewCard in index.html).
          isSeries: isBookSeriesReview || undefined,
        },
        myReaction: req.user ? (r.reactions.find(rx => rx.userId === req.user.id)?.emoji || null) : null,
        myRatingForItem: myRatingByItem[r.mediaItemId] ?? null,
        reactionSummary: r.reactions.reduce((acc, { emoji }) => {
          acc[emoji] = (acc[emoji] || 0) + 1; return acc;
        }, {}),
      };
    });

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
