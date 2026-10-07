// src/routes/feed.js
const router = require('express').Router();
const { query } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { buildSeriesRepMap } = require('../lib/mediaHelpers');
const { START_HERE } = require('../lib/startHere');
const { PIONEER_LIMIT } = require('../lib/badges');

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
      // Imports are not activity. Somebody moving ten years of Letterboxd
      // history across did not watch 900 films this afternoon, and a feed
      // saying they did buries every other person's actual review — which is
      // the whole reason this route exists.
      //
      // Only the feed hides them. They still count toward a title's rating,
      // still appear on the author's profile and on the item page, and still
      // earn badges: the opinion is real, the broadcast is not.
      isImported: false,
      // Chosen by the reviewer: reviewed, counted, on the title's page, but
      // deliberately not broadcast. See Review.hiddenFromFeed.
      hiddenFromFeed: false,
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

    // ── Import entries ───────────────────────────────────────────────────
    // The reviews from an import are hidden (Review.isImported), so without
    // this somebody who just moved a decade of history across would appear to
    // have done nothing. One entry says what happened.
    //
    // Slotted into the page whose time window contains it, rather than always
    // pinned to the top: page 1 takes everything newer than its newest review,
    // the last page everything older than its oldest, and each middle page the
    // span between. That way an event belongs to exactly one page and
    // "load more" can neither duplicate nor skip it.
    const pages = Math.ceil(total / take);
    const newest = enriched[0]?.updatedAt;
    const oldest = enriched[enriched.length - 1]?.updatedAt;
    const window = {};
    if (page > 1 && newest) window.lte = newest;
    if (page < pages && oldest) window.gte = oldest;

    // Same visibility rules as the reviews themselves: in Friends mode only
    // friends, otherwise only people whose profile the viewer could open.
    const eventAuthor = authorIds
      ? { userId: { in: authorIds } }
      : {
          OR: [
            { user: { profilePublic: true } },
            ...(req.user ? [{ userId: req.user.id }, { userId: { in: friendIds } }] : []),
          ],
        };

    // One createdAt filter, not two spread over each other — the page window
    // and the timeframe are both lower bounds, so the tighter of the two wins
    // rather than the later spread silently replacing the earlier.
    const createdAt = { ...window };
    if (since && (!createdAt.gte || since > createdAt.gte)) createdAt.gte = since;

    const events = await prisma.importEvent.findMany({
      where: {
        ...eventAuthor,
        ...(Object.keys(createdAt).length ? { createdAt } : {}),
      },
      include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true, avatarEmoji: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // Merged by time so the feed reads chronologically. `kind` is what the
    // client branches on — a review has no kind, which keeps every existing
    // caller working untouched.
    const items = [
      ...enriched,
      ...events.map(e => ({
        kind: 'import',
        id: `import-${e.id}`,
        user: e.user,
        source: e.source,
        created: e.created,
        updated: e.updated,
        pending: e.pending,
        createdAt: e.createdAt,
        updatedAt: e.createdAt,
      })),
    ].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json({
      reviews: items, total, page,
      pages,
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

// ─── GET /api/feed/start-here ──────────────────────────────────────────────
// Films picked to be argued about, for the homepage slot that used to hold
// Trending. See src/lib/startHere.js for why the list is curated rather than
// ranked.
//
// Trending could not do this job yet: the most-reviewed title in the whole
// catalogue has three reviews, so a box claiming to show what is popular was
// advertising the one thing the site does not have. This asks for an opinion
// instead, which is something a brand-new visitor can actually supply.
//
// Deliberately unauthenticated — the visitor it exists for has no account.
router.get('/start-here', async (req, res, next) => {
  try {
    const items = await prisma.mediaItem.findMany({
      where: {
        verified: true,
        OR: START_HERE.map(e => ({
          mediaType: e.type, title: e.title, releaseYear: e.year,
          // A show's opinion belongs on the parent row — a season is a
          // narrower argument. Books have no parent/child relation at all, so
          // constraining them on it would match nothing.
          ...(e.type === 'BOOK' ? {} : { parentId: null }),
        })),
      },
      select: {
        id: true, title: true, slug: true, imageUrl: true,
        releaseYear: true, mediaType: true, seriesName: true,
        // Only what an anonymous visitor could see anyway. A private or draft
        // review is not this page's business to disclose the existence of.
        _count: { select: { reviews: { where: { isDraft: false, visibility: 'PUBLIC' } } } },
      },
    });

    const shuffle = a => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    // Picked per type rather than from one pool. The list is 44 films, 24
    // shows and a single book, so a straight shuffle would carry the book
    // about a third of the time and under-represent television badly — and
    // the whole point of including them is that this catalogue is not only
    // films. Quotas are filled in order of scarcity and anything short is
    // backfilled from what is left, so the slot is always full.
    // Six, not twenty. At twenty this card rendered 1,347px tall on a phone —
    // more than a screen and a half of things to go and do, stacked between an
    // arriving visitor and the first real review on the page. The list is
    // shuffled per request, so a short one still varies between visits.
    const QUOTA = [['BOOK', 1], ['TV_SHOW', 2], ['MOVIE', 3]];
    const byType = new Map(QUOTA.map(([t]) => [t, shuffle(items.filter(m => m.mediaType === t))]));

    // One number, derived from the quota, so changing the size cannot leave
    // the backfill padding to a different target and silently flattening the
    // mix — which is exactly what happened when this said 20 and the quota
    // said 6: the single book was padded out and then sliced away.
    const WANT = QUOTA.reduce((a, [, n]) => a + n, 0);

    const picked = [];
    for (const [type, n] of QUOTA) picked.push(...byType.get(type).splice(0, n));
    if (picked.length < WANT) {
      const rest = shuffle([...byType.values()].flat());
      picked.push(...rest.slice(0, WANT - picked.length));
    }

    // Interleaved, so it reads as a mixed shelf rather than three blocks.
    res.json(shuffle(picked).slice(0, WANT).map(m => ({
      id: m.id, title: m.title, slug: m.slug, imageUrl: m.imageUrl,
      releaseYear: m.releaseYear, mediaType: m.mediaType,
      // The frontend needs this to link a series book to its own page rather
      // than to the series rollup — see the ?book=1 param on item.html.
      inSeries: !!m.seriesName,
      reviewCount: m._count.reviews,
    })));
  } catch (err) { next(err); }
});

// ─── GET /api/feed/badge-stats ─────────────────────────────────────────────
// Public, tiny, and for the logged-out landing page: how many Pioneer places
// are left. Scarcity only works as an invitation if the number is real and
// visible before signing up, so this is deliberately unauthenticated.
router.get('/badge-stats', async (req, res, next) => {
  try {
    const claimed = await prisma.userBadge.count({ where: { code: 'PIONEER' } });
    res.json({
      pioneer: {
        limit: PIONEER_LIMIT,
        claimed,
        remaining: Math.max(0, PIONEER_LIMIT - claimed),
      },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/feed/sample-card ─────────────────────────────────────────────
// A real taste card for the logged-out landing page.
//
// The ads lead with a shareable stat card (see CLAUDE.md) and the homepage
// showed nothing of the kind — people were clicking a card and arriving at a
// sign-up form. Cards are per-user and need an account, so this serves a real
// one from a public profile as the worked example.
//
// Deliberately NOT /users/:username/taste-profile, which the page could call
// directly: that response is 13.6 MB and takes ~1.4s, because it carries every
// favourite with full item lists. Unacceptable anywhere, and indefensible as
// the first thing a visitor on mobile data downloads. This returns about a
// kilobyte.
const SAMPLE_CARD_USER = 'rufiohhhhh';
const SAMPLE_CARD_TTL  = 30 * 60 * 1000;
// At least this many titles before a name is worth printing on a card. Below
// it the "favourite actor" is whoever appeared twice in something rated 10,
// which is noise dressed as insight.
//
// Seven rather than five: at five the top slot went to somebody with exactly
// five appearances and a high average, which is a coincidence rather than a
// pattern. Seven also guarantees more than the five covers the card shows,
// so the strip is never short.
const SAMPLE_CARD_MIN_TITLES = 7;
// Covers shown beside the headline name.
const SAMPLE_CARD_COVERS = 5;
let sampleCardCache = { at: 0, data: null };

router.get('/sample-card', async (req, res, next) => {
  try {
    if (sampleCardCache.data && Date.now() - sampleCardCache.at < SAMPLE_CARD_TTL) {
      return res.json(sampleCardCache.data);
    }

    const user = await prisma.user.findUnique({
      where: { username: SAMPLE_CARD_USER },
      select: { id: true, username: true, profilePublic: true, canceledAt: true },
    });
    // Never leak a profile that has since been made private or closed.
    if (!user || user.canceledAt || !user.profilePublic) return res.status(404).json({ error: 'No sample available' });

    const byType = await prisma.$queryRawUnsafe(`
      SELECT m."mediaType", COUNT(*)::int n
      FROM "Review" r JOIN "MediaItem" m ON m.id = r."mediaItemId"
      WHERE r."userId" = $1 AND r."isDraft" = false AND r.visibility = 'PUBLIC'
      GROUP BY 1`, user.id);

    // The headline: the actor they rate highest across enough titles to mean
    // something. One query rather than the whole taste profile.
    const [top] = await prisma.$queryRawUnsafe(`
      SELECT p.name, COUNT(DISTINCT m.id)::int AS titles, ROUND(AVG(r.rating)::numeric, 1)::float AS avg
      FROM "Review" r
      JOIN "MediaItem" m ON m.id = r."mediaItemId"
      JOIN "_AppearedIn" a ON a."A" = m.id
      JOIN "Person" p ON p.id = a."B"
      WHERE r."userId" = $1 AND r."isDraft" = false AND r.visibility = 'PUBLIC'
      GROUP BY p.id, p.name
      HAVING COUNT(DISTINCT m.id) >= $2
      ORDER BY AVG(r.rating) DESC, COUNT(DISTINCT m.id) DESC
      LIMIT 1`, user.id, SAMPLE_CARD_MIN_TITLES);

    // Highest-rated first. Without an ORDER BY this took whatever five rows
    // Postgres happened to return, so the card showed an arbitrary handful
    // rather than the top titles it implies — the one thing a reader checks.
    //
    // The isDraft/visibility filters match the two queries above. They were
    // missing here, which both let a private or unpublished review put a
    // cover on the public landing page and let the strip disagree with the
    // average printed next to it.
    //
    // DISTINCT ON collapses a title that joins twice (a show and its seasons
    // both credit the person) to its best-rated row before the final sort.
    const covers = top ? await prisma.$queryRawUnsafe(`
      SELECT "imageUrl", title, rating FROM (
        SELECT DISTINCT ON (m.id) m.id, m."imageUrl", m.title, r.rating
        FROM "Review" r
        JOIN "MediaItem" m ON m.id = r."mediaItemId"
        JOIN "_AppearedIn" a ON a."A" = m.id
        JOIN "Person" p ON p.id = a."B"
        WHERE r."userId" = $1 AND p.name = $2
          AND m."imageUrl" IS NOT NULL
          AND r."isDraft" = false AND r.visibility = 'PUBLIC'
        ORDER BY m.id, r.rating DESC
      ) t
      ORDER BY rating DESC, title ASC
      LIMIT $3`, user.id, top.name, SAMPLE_CARD_COVERS) : [];

    const data = {
      username: user.username,
      totalReviews: byType.reduce((a, r) => a + r.n, 0),
      byType: Object.fromEntries(byType.map(r => [r.mediaType, r.n])),
      highlight: top ? { kind: 'actor', name: top.name, titles: top.titles, avgRating: top.avg, covers } : null,
    };
    sampleCardCache = { at: Date.now(), data };
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
