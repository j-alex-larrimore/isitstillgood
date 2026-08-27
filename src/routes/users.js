// src/routes/users.js
const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const prisma  = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { pickSeriesRepresentative } = require('../lib/mediaHelpers');

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
  const { displayName, bio, profilePublic, defaultVisibility, tasteThreshold } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { displayName, bio, profilePublic, defaultVisibility, ...(tasteThreshold !== undefined && { tasteThreshold: parseInt(tasteThreshold) }) },
      select: { id: true, username: true, displayName: true, bio: true, avatarUrl: true, profilePublic: true, defaultVisibility: true, tasteThreshold: true },
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
  query('seasonNumber').optional().custom(v => v === 'null' || /^-?\d+$/.test(v)),
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
      ...(typeFilter && { mediaItem: { is: { mediaType: typeFilter } } }),
      // seasonNumber: 0 is the book-series sentinel — passed explicitly by
      // the rating-comparison widget when the item being rated is a series,
      // so it compares against the user's other series-level reviews rather
      // than their individual book ratings. "null" (literal string) is the
      // opposite case: rating an individual book excludes seasonNumber:0 so
      // a series-level review doesn't show up as if it were a book rating.
      ...(req.query.seasonNumber !== undefined && {
        seasonNumber: req.query.seasonNumber === 'null' ? null : parseInt(req.query.seasonNumber),
      }),
    };

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          mediaItem: {
            select: {
              id: true, title: true, mediaType: true, releaseYear: true,
              imageUrl: true, slug: true, genres: true, tags: true,
              tmdbRating: true, openCriticScore: true,
              seriesName: true, seriesNumber: true,
            },
          },
          _count: { select: { reactions: true, comments: true } },
        },
        // Postgres defaults DESC ordering to NULLS FIRST, which put undated
      // reviews at the top of the list instead of the bottom — explicit
      // nulls:'last' fixes that.
      orderBy: [{ dateConsumed: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
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
        canceledAt: null,
        OR: [
          // Search by username (partial match, case-insensitive)
          { username:    { contains: req.query.q, mode: 'insensitive' } },
          // Search by display name
          { displayName: { contains: req.query.q, mode: 'insensitive' } },
          // Search by email — allows finding friends who haven't set a username yet
          // or when you only know someone's email address
          { email:       { contains: req.query.q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true, username: true, displayName: true, avatarUrl: true,
        _count: { select: { reviews: true } },
      },
      take: 20,
    });
    res.json(users.map(u => ({
      id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl,
      reviewCount: u._count?.reviews || 0,
    })));
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
        bio: true, avatarUrl: true, avatarEmoji: true, profilePublic: true,
        createdAt: true, email: true, canceledAt: true,
        // Count total reviews for the stats section
        _count: { select: { reviews: true } },
      },
    });
    // A canceled profile is gone — same response as a nonexistent username
    if (!target || target.canceledAt) return res.status(404).json({ error: 'User not found' });

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
      // Return minimal info so the page can show a "friends only" message —
      // id is included (opaque CUID, not sensitive) so the frontend can
      // still offer "add as friend" from this gated state, since that's the
      // actual way to unlock viewing a private profile.
      return res.status(403).json({
        error: 'friends_only',
        id: target.id,
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
      // Postgres defaults DESC ordering to NULLS FIRST, which put undated
      // reviews at the top of the list instead of the bottom — explicit
      // nulls:'last' fixes that.
      orderBy: [{ dateConsumed: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
      take: 20,
    });

    // Compute aggregate stats
    const stats = await prisma.review.aggregate({
      where: { userId: target.id },
      _avg: { rating: true },
      _count: { rating: true },
    });

    // Verdict breakdown — legacy field kept for compatibility
    const verdicts = await prisma.review.groupBy({
      by: ['verdict'],
      where: { userId: target.id },
      _count: { verdict: true },
    });

    // Rating breakdown — count per rating value 1-10 (the new word-based system)
    const ratingGroups = await prisma.review.groupBy({
      by: ['rating'],
      where: { userId: target.id },
      _count: { rating: true },
    });
    const ratingCounts = Object.fromEntries(ratingGroups.map(g => [g.rating, g._count.rating]));

    res.json({
      user: {
        ...target,
        email: isSelf ? target.email : undefined,
      },
      isSelf,
      reviews,
      stats: {
        totalReviews:  stats._count.rating,
        avgRating:     stats._avg.rating,
        verdictCounts: Object.fromEntries(verdicts.map(v => [v.verdict, v._count.verdict])),
        ratingCounts,
      },
    });
  } catch (err) { next(err); }
});

// Curated feed-avatar icon set — the ONLY values PATCH /me/settings will
// accept for avatarEmoji below. Kept as a fixed palette rather than a free
// text field on purpose: this is meant to be a fun, lightweight identity
// marker for the public feed (see index.html's renderReviewCard), not an
// open text input someone could fill with something offensive. GET
// /me/settings/avatar-icons exposes this same list so the frontend picker
// never drifts out of sync with what the backend actually allows.
const FEED_AVATAR_ICONS = [
  '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐸', '🐙', '🦉', '🦄',
  '🐢', '🦋', '🐬', '🦖', '🐝', '🐧', '🦩', '🦜', '🐺', '🦔',
  '🎬', '📚', '🎮', '🎲', '🕹️', '👾', '🎧', '🎨',
  '🔥', '⭐', '🌙', '☕', '🍕', '🚀', '👑', '💎',
];

// ─── GET /api/users/me/settings/avatar-icons ─── The pickable icon set ────────
router.get('/me/settings/avatar-icons', (req, res) => {
  res.json(FEED_AVATAR_ICONS);
});

// ─── PATCH /api/users/me/settings ─── Update profile visibility ───────────────
// Allows the logged-in user to toggle profilePublic and update their bio.
// Email is deliberately NOT handled here — changing it now requires clicking
// a confirmation link (see POST /api/auth/change-email), since writing it
// directly here had no verification and no password check at all.
router.patch('/me/settings', requireAuth, [
  body('profilePublic').optional().isBoolean(),
  body('bio').optional().trim().isLength({ max: 500 }),
  body('displayName').optional().trim().isLength({ min: 1, max: 100 }),
  // Same format rule as signup (POST /api/auth/register) — a changed
  // username still has to satisfy whatever a brand-new one would.
  body('username').optional().matches(/^[a-zA-Z0-9_]{3,30}$/).withMessage('Username: 3-30 chars, letters/numbers/underscores only'),
  // null/empty clears the pick, reverting the feed to plain username
  // initials (see index.html) — anything else must be one of the curated
  // icons, never an arbitrary string.
  body('avatarEmoji').optional({ nullable: true }).custom(v => v === null || v === '' || FEED_AVATAR_ICONS.includes(v))
    .withMessage('Not a valid feed icon'),
], async (req, res, next) => {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(422).json({ errors: e.array() });
  try {
    const data = {};
    if (req.body.profilePublic !== undefined) data.profilePublic = req.body.profilePublic;
    if (req.body.bio !== undefined)           data.bio           = req.body.bio;
    if (req.body.displayName !== undefined)   data.displayName   = req.body.displayName;
    if (req.body.username !== undefined)      data.username      = req.body.username;
    if (req.body.avatarEmoji !== undefined)   data.avatarEmoji   = req.body.avatarEmoji || null;

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true, username: true, displayName: true,
        bio: true, profilePublic: true, email: true, avatarEmoji: true,
      },
    });
    res.json(updated);
  } catch (err) {
    // @@unique on username — a taken name, not a real server error. Note a
    // rename doesn't touch the JWT (it only ever carries the user id, see
    // src/lib/tokens.js), so no re-login is needed; existing short share
    // links minted under the old username DO go stale, though (ShareLink.path
    // is a stored literal string with no user-id reference to resolve
    // through) — an accepted gap, not handled here.
    if (err.code === 'P2002') return res.status(409).json({ error: 'Username taken' });
    next(err);
  }
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
      select: { id: true, username: true, displayName: true, profilePublic: true, ignoredGenres: true, canceledAt: true },
    });
    if (!target || target.canceledAt) return res.status(404).json({ error: 'User not found' });

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
    const reviews = await prisma.review.findMany({
      where: {
        userId: target.id,
        visibility: { in: ['PUBLIC', 'FRIENDS_ONLY'] },
      },
      select: {
        rating: true, seasonNumber: true,
        mediaItem: {
          select: {
            id: true, title: true, slug: true,
            mediaType: true, releaseYear: true, imageUrl: true,
            genres: true, tags: true, parentId: true,
            seriesName: true, seriesNumber: true,
            directors: { select: { id: true, name: true, slug: true } },
            cast:      { select: { id: true, name: true, slug: true } },
            authors:   { select: { id: true, name: true, slug: true } },
            // For TV seasons, the parent show carries the real creative-team
            // data (main cast, creators) — a season row only has guest cast/
            // deltas — plus the identifying fields needed to treat the whole
            // series as one item when consolidating ratings below.
            parent: {
              select: {
                id: true, title: true, slug: true, imageUrl: true, releaseYear: true,
                cast:      { select: { id: true, name: true, slug: true } },
                directors: { select: { id: true, name: true, slug: true } },
                genres:    true, tags: true,
              },
            },
          },
        },
      },
    });

    // Consolidate TV reviews to one rating per show, not one per season —
    // treat the whole series as a single data point: the explicit series-
    // level review if the user wrote one (a review directly on the parent
    // row, seasonNumber:null), otherwise the average of whatever seasons
    // they did review. Previously every season review counted separately
    // using its own rating, so an 8-season show reviewed season-by-season
    // contributed 8 ratings toward a director/actor's average instead of 1,
    // and used only that season's guest cast — main cast/creators live on
    // the parent row and were mostly invisible to favorites as a result.
    // A book series-level review (seasonNumber:0 sentinel, written against
    // whatever book was the series representative at the time) goes stale
    // the same way item.html's series page already accounts for: adding an
    // earlier-numbered prequel/novella later shifts the representative to
    // that new book without moving the existing review. Resolve to the
    // CURRENT representative here too, so taste-profile covers/titles don't
    // show the old representative (e.g. a novella) instead of book 1.
    // Confirmed live: Glass Immortals showed "Montego" (0.5) instead of "In
    // the Shadow of Lightning" (1) once book 1 was added after the review.
    const seriesRepCache = new Map(); // seriesName|authorIds -> representative row or null
    async function resolveSeriesRepresentative(item) {
      const authorIds = (item.authors || []).map(a => a.id).sort();
      const key = `${item.seriesName}|${authorIds.join(',')}`;
      if (seriesRepCache.has(key)) return seriesRepCache.get(key);
      const clusterBooks = await prisma.mediaItem.findMany({
        where: {
          mediaType: 'BOOK', seriesName: item.seriesName, seriesNumber: { not: null },
          verified: true, authors: { some: { id: { in: authorIds } } },
        },
        select: { id: true, title: true, slug: true, imageUrl: true, releaseYear: true, seriesNumber: true },
      });
      const rep = clusterBooks.length ? pickSeriesRepresentative(clusterBooks) : null;
      seriesRepCache.set(key, rep);
      return rep;
    }

    const tvGroups = new Map(); // effective show id -> { seriesRating, seasonRatings, showItem }
    const processedEntries = [];
    for (const review of reviews) {
      const item = review.mediaItem;
      if (item.mediaType !== 'TV_SHOW') {
        let effectiveItem = item;
        if (item.mediaType === 'BOOK' && item.seriesName && review.seasonNumber === 0) {
          const rep = await resolveSeriesRepresentative(item);
          if (rep && rep.id !== item.id) {
            // displayTitle carries the series name through to itemSummary()
            // below — a series-level review should show as e.g. "The Wheel
            // of Time" on taste cards, not "The Eye of the World" (book 1's
            // own title), matching how /api/media already labels series
            // cards for Browse. title/slug/etc. still point at the actual
            // representative row, since that's what the link needs to go to.
            effectiveItem = { ...item, id: rep.id, title: rep.title, slug: rep.slug, imageUrl: rep.imageUrl, releaseYear: rep.releaseYear, displayTitle: item.seriesName };
          }
        }
        processedEntries.push({
          rating: review.rating, item: effectiveItem,
          seriesLevel: item.mediaType === 'BOOK' && review.seasonNumber === 0,
        });
        continue;
      }
      if (item.parentId) {
        // Season-level review — group under the parent; use the parent's
        // own cast/directors/genres, the show's real creative-team data.
        if (!tvGroups.has(item.parentId)) {
          tvGroups.set(item.parentId, {
            seriesRating: null,
            seasonRatings: [],
            showItem: item.parent
              ? { ...item.parent, mediaType: 'TV_SHOW' }
              : { ...item, mediaType: 'TV_SHOW' }, // parent wasn't fetched (shouldn't normally happen) — fall back to the season's own data rather than dropping it
          });
        }
        tvGroups.get(item.parentId).seasonRatings.push(review.rating);
      } else {
        // No parentId — this review is directly on the parent show's own
        // row, i.e. an explicit "rate the whole series" review. Takes
        // priority over any season averages for the same show.
        if (!tvGroups.has(item.id)) tvGroups.set(item.id, { seriesRating: null, seasonRatings: [], showItem: item });
        tvGroups.get(item.id).seriesRating = review.rating;
      }
    }
    for (const { seriesRating, seasonRatings, showItem } of tvGroups.values()) {
      const rating = seriesRating != null
        ? seriesRating
        : seasonRatings.reduce((a, b) => a + b, 0) / seasonRatings.length;
      processedEntries.push({ rating, item: showItem });
    }

    // ── Series-condensed view (Author cards only) ──────────────────────────
    // A series reviewed book-by-book (13 Cradle books averaging 7.1) vs.
    // rated as a whole (one series-level review of 9) are very different
    // "favorite author" signals, and unlike TV — always consolidated to one
    // rating per show above — books default to counting every review
    // individually. This builds the alternate "condensed" view: every book
    // series the user touched collapses to ONE data point (their own
    // series-level rating if they wrote one, else the average of whichever
    // books in that series they rated individually), same rule TV already
    // uses. Non-series entries pass through unchanged either way. Powers the
    // series-count toggle on the Author taste cards (authorsCondensed below)
    // — left BOOK-only/author-only since that's the only category where
    // per-review counting was skewing a "how many things" signal.
    const bookSeriesClusters = new Map(); // seriesName|authorIds -> { seriesRating, bookRatings, sampleItem }
    const condensedEntries = [];
    for (const entry of processedEntries) {
      const item = entry.item;
      if (item.mediaType === 'BOOK' && item.seriesName) {
        const authorIds = (item.authors || []).map(a => a.id).sort();
        const key = `${item.seriesName}|${authorIds.join(',')}`;
        if (!bookSeriesClusters.has(key)) bookSeriesClusters.set(key, { seriesRating: null, bookRatings: [], sampleItem: item });
        const cluster = bookSeriesClusters.get(key);
        if (entry.seriesLevel) cluster.seriesRating = entry.rating;
        else cluster.bookRatings.push(entry.rating);
      } else {
        condensedEntries.push(entry);
      }
    }
    for (const cluster of bookSeriesClusters.values()) {
      const rating = cluster.seriesRating != null
        ? cluster.seriesRating
        : cluster.bookRatings.reduce((a, b) => a + b, 0) / cluster.bookRatings.length;
      // Always resolve to the TRUE current representative (book 1) for the
      // cover/link shown — not just whichever book happened to be seen
      // first while building the cluster. displayTitle carries the series
      // name through to itemSummary() below, same reasoning as the
      // series-level-review branch above — a condensed author card is
      // always conceptually "the series", so it should read as e.g. "The
      // Wheel of Time", not book 1's own title.
      const rep = await resolveSeriesRepresentative(cluster.sampleItem);
      const repItem = rep
        ? { ...cluster.sampleItem, id: rep.id, title: rep.title, slug: rep.slug, imageUrl: rep.imageUrl, releaseYear: rep.releaseYear, displayTitle: cluster.sampleItem.seriesName }
        : { ...cluster.sampleItem, displayTitle: cluster.sampleItem.seriesName };
      condensedEntries.push({ rating, item: repItem });
    }

    // ── Helper: build a ranked list from person/genre occurrences ─────────────
    // Takes a map of { id/name -> { name, slug?, ratings: [] } }
    // Returns array sorted by avgRating desc, filtered to min 2 entries
    function rankEntries(map, minCount = 1, topN = 5) {
      return Object.values(map)
        .filter(entry => entry.ratings.length >= minCount)
        .map(entry => ({
          name:      entry.name,
          slug:      entry.slug || null,
          count:     entry.ratings.length,
          // Defaults to count for every category — only authorsCondensed
          // overrides it, to the true (pre-condensing) review count, so the
          // "min. appearances" threshold still gates on real review volume
          // even when a series has been collapsed to one entry.
          totalReviewCount: entry.totalReviewCount ?? entry.ratings.length,
          avgRating: entry.ratings.reduce((a, b) => a + b, 0) / entry.ratings.length,
          items:     entry.items || [],
        }))
        .sort((a, b) => b.avgRating - a.avgRating || b.count - a.count)
        .slice(0, topN);
    }

    // Same shape as rankEntries, but worst avgRating first — powers the
    // "Least Favorite" cards. Tie-break still favors more appearances (more
    // reviewed data behind a low rating reads as more genuinely disliked
    // than one bad review of something barely watched).
    function rankEntriesAscending(map, minCount = 1, topN = 5) {
      return Object.values(map)
        .filter(entry => entry.ratings.length >= minCount)
        .map(entry => ({
          name:      entry.name,
          slug:      entry.slug || null,
          count:     entry.ratings.length,
          totalReviewCount: entry.totalReviewCount ?? entry.ratings.length,
          avgRating: entry.ratings.reduce((a, b) => a + b, 0) / entry.ratings.length,
          items:     entry.items || [],
        }))
        .sort((a, b) => a.avgRating - b.avgRating || b.count - a.count)
        .slice(0, topN);
    }

    // ── Accumulate ratings per director, actor, author, genre — split by media type ──
    // We track per-type counts so we can apply a dynamic threshold:
    // to qualify as "favorite", a genre/person must appear in at least
    // 1/10th of all reviews in that type (min 1), making the bar proportional.
    const directors = {}, actors = {}, authors = {}, genres = {};
    const countByType = {}; // total reviews per media type

    // Build a lowercase set of ignored genres for fast lookup
    const ignoredSet = new Set((target.ignoredGenres || []).map(g => g.toLowerCase()));

    // mediaItem summary for linking from taste cards. displayTitle only
    // exists on items resolved to a book-series representative above (a
    // series-level review, or a condensed-view cluster) — everywhere else
    // it's undefined, so an individually-rated book still shows its own
    // title, not its series' name.
    const itemSummary = (item, rating) => ({
      id: item.id, title: item.title, slug: item.slug,
      mediaType: item.mediaType, imageUrl: item.imageUrl,
      releaseYear: item.releaseYear, rating,
      displayTitle: item.displayTitle || undefined,
    });

    for (const entry of processedEntries) {
      const item   = entry.item;
      const rating = entry.rating;
      const type   = item.mediaType;

      countByType[type] = (countByType[type] || 0) + 1;

      for (const p of (item.directors || [])) {
        if (!directors[p.id]) directors[p.id] = { name: p.name, slug: p.slug, ratings: [], types: {}, items: [] };
        directors[p.id].ratings.push(rating);
        directors[p.id].types[type] = (directors[p.id].types[type] || 0) + 1;
        directors[p.id].items.push(itemSummary(item, rating));
      }
      for (const p of (item.cast || [])) {
        if (!actors[p.id]) actors[p.id] = { name: p.name, slug: p.slug, ratings: [], types: {}, items: [] };
        actors[p.id].ratings.push(rating);
        actors[p.id].types[type] = (actors[p.id].types[type] || 0) + 1;
        actors[p.id].items.push(itemSummary(item, rating));
      }
      for (const p of (item.authors || [])) {
        if (!authors[p.id]) authors[p.id] = { name: p.name, slug: p.slug, ratings: [], types: {}, items: [] };
        authors[p.id].ratings.push(rating);
        authors[p.id].types[type] = (authors[p.id].types[type] || 0) + 1;
        authors[p.id].items.push(itemSummary(item, rating));
      }
      for (const g of (item.genres || [])) {
        if (ignoredSet.has(g.toLowerCase())) continue; // skip user-ignored genres
        if (!genres[g]) genres[g] = { name: g, ratings: [], types: {}, items: [] };
        genres[g].ratings.push(rating);
        genres[g].types[type] = (genres[g].types[type] || 0) + 1;
        genres[g].items.push(itemSummary(item, rating));
      }
    }

    // Same shape as `authors` above, but built from condensedEntries — see
    // the comment on bookSeriesClusters for what "condensed" means.
    const authorsCondensed = {};
    for (const entry of condensedEntries) {
      const item = entry.item, rating = entry.rating;
      for (const p of (item.authors || [])) {
        if (!authorsCondensed[p.id]) authorsCondensed[p.id] = { name: p.name, slug: p.slug, ratings: [], items: [] };
        authorsCondensed[p.id].ratings.push(rating);
        authorsCondensed[p.id].items.push(itemSummary(item, rating));
      }
    }
    // The "min. appearances" threshold should still gate on the TRUE number
    // of reviews behind an author (14 for someone who wrote 13 Cradle books
    // + 1 series review), not the condensed count (1) — otherwise condensing
    // a series down to one card entry would make that author fail a filter
    // they clearly clear. Carries the real (expanded) count alongside the
    // condensed one so the frontend can filter on one and display the other.
    for (const id of Object.keys(authorsCondensed)) {
      authorsCondensed[id].totalReviewCount = authors[id]?.ratings.length ?? authorsCondensed[id].ratings.length;
    }

    // Dynamic threshold: at least 1/10th of reviews in that type, minimum 1
    function threshold(typeCount) {
      return Math.max(1, Math.floor(typeCount / 10));
    }

    // ── Build per-media-type genre breakdowns with dynamic thresholds ──────────
    const genresByType = {};
    for (const entry of processedEntries) {
      const type = entry.item.mediaType;
      if (!genresByType[type]) genresByType[type] = {};
      for (const g of (entry.item.genres || [])) {
        if (ignoredSet.has(g.toLowerCase())) continue;
        // items:[] was missing here — unlike the overall `genres` accumulator
        // above, this per-type breakdown never recorded which reviews backed
        // each genre, so "Favorite X Genre" cards had nothing to show when
        // clicked. Confirmed live: Book and Game genre cards opened to an
        // empty project list (every type has this bug, but it's most visible
        // on types with no director/actor cards to mask it).
        if (!genresByType[type][g]) genresByType[type][g] = { name: g, ratings: [], items: [] };
        genresByType[type][g].ratings.push(entry.rating);
        genresByType[type][g].items.push(itemSummary(entry.item, entry.rating));
      }
    }
    const favoriteGenreByType = {};
    const mostReviewedGenreByType = {};
    for (const [type, gMap] of Object.entries(genresByType)) {
      const minCount = threshold(countByType[type] || 0);
      // topN: Infinity, not a small fixed cap — the frontend re-filters this
      // same data for every "min. appearances" threshold the user picks
      // without a new API call. A small cap here meant raising the threshold
      // could zero out a whole category even when a lower-rated-but-more-
      // reviewed genre existed just outside the cut — it was never sent to
      // the client to be considered. Confirmed live: "Favorite Actor"
      // vanishing when raising the threshold from 2 to 3.
      const byRating = rankEntries(gMap, minCount, Infinity);
      const byCount  = rankByCount(gMap, minCount, Infinity);
      if (byRating.length) favoriteGenreByType[type]     = byRating;
      if (byCount.length)  mostReviewedGenreByType[type] = byCount;
    }

    // ── Per-media-type decade breakdowns — same shape/threshold as genre
    // above, but keyed by release-decade instead of genre string. Items with
    // no releaseYear (a handful of untimestamped catalog entries) are simply
    // excluded from this breakdown rather than bucketed under some
    // placeholder decade.
    //
    // TV needs its own pass rather than reusing processedEntries: that list
    // consolidates every review of a show down to ONE rating (correct for
    // genre/cast/director, which don't change season to season), tagged with
    // the PARENT show's own releaseYear (its original premiere). A season
    // reviewed individually can air a full decade+ after that premiere on a
    // long-running show, so decade attribution needs each SEASON's own
    // releaseYear, not the parent's — otherwise every season of a show that
    // premiered in the 1990s gets bucketed as "1990s" even if the specific
    // season reviewed actually aired in the 2010s. A series-level review
    // (made directly on the parent row, no specific season) has no
    // individual season to attribute to, so it still falls back to the
    // parent's own releaseYear — the only sensible year available for "the
    // show as a whole". Books/movies/games are unaffected: processedEntries
    // already carries one entry per individual review for those types (only
    // an explicit series-level book review resolves to the series
    // representative's year, same reasoning as the TV series-level case).
    function addDecadeEntry(map, item, rating) {
      const year = item.releaseYear;
      if (year == null) return;
      const label = `${Math.floor(year / 10) * 10}s`;
      if (!map[item.mediaType]) map[item.mediaType] = {};
      if (!map[item.mediaType][label]) map[item.mediaType][label] = { name: label, ratings: [], items: [] };
      map[item.mediaType][label].ratings.push(rating);
      map[item.mediaType][label].items.push(itemSummary(item, rating));
    }
    const decadesByType = {};
    for (const entry of processedEntries) {
      if (entry.item.mediaType === 'TV_SHOW') continue; // handled below, per-season
      addDecadeEntry(decadesByType, entry.item, entry.rating);
    }
    for (const review of reviews) {
      const item = review.mediaItem;
      if (item.mediaType !== 'TV_SHOW') continue;
      // item.parentId present = a season-level review — item IS the season
      // row itself, carrying that season's own releaseYear. No parentId = a
      // series-level review made directly on the parent row, where item
      // already IS the parent.
      addDecadeEntry(decadesByType, { ...item, mediaType: 'TV_SHOW' }, review.rating);
    }
    const favoriteDecadeByType = {};
    const leastFavoriteDecadeByType = {};
    for (const [type, dMap] of Object.entries(decadesByType)) {
      const minCount = threshold(countByType[type] || 0);
      const byRating = rankEntries(dMap, minCount, Infinity);
      const byLeast  = rankEntriesAscending(dMap, minCount, Infinity);
      if (byRating.length) favoriteDecadeByType[type]      = byRating;
      if (byLeast.length)  leastFavoriteDecadeByType[type]  = byLeast;
    }

    // ── Per-type tag breakdowns — Games, Books, and a merged TV/Movies bucket
    // (mirroring Browse's own MOVIE+TV_SHOW "Screen" grouping, since a tag
    // like "Marvel" or "HBO" is just as relevant compared across both).
    // Favorite/Least Favorite only — no "Most Reviewed" variant was asked for.
    // Tags use a flat minimum count (not the 10%-of-total dynamic threshold()
    // used for genres) — tags are narrower categories than genres, so the
    // percentage-based bar excluded tags with real sample sizes (e.g. MCU at
    // 53 reviews out of 594 total didn't clear a 59-review bar).
    const TAG_MIN_COUNT = 10;
    const TAG_BUCKET = { MOVIE: 'SCREEN', TV_SHOW: 'SCREEN', BOOK: 'BOOK', VIDEO_GAME: 'VIDEO_GAME' };
    const tagsByBucket = {};
    for (const entry of processedEntries) {
      const bucket = TAG_BUCKET[entry.item.mediaType];
      if (!bucket) continue;
      if (!tagsByBucket[bucket]) tagsByBucket[bucket] = {};
      for (const t of (entry.item.tags || [])) {
        if (!tagsByBucket[bucket][t]) tagsByBucket[bucket][t] = { name: t, ratings: [], items: [] };
        tagsByBucket[bucket][t].ratings.push(entry.rating);
        tagsByBucket[bucket][t].items.push(itemSummary(entry.item, entry.rating));
      }
    }
    const favoriteTagByType = {};
    const leastFavoriteTagByType = {};
    for (const [bucket, tMap] of Object.entries(tagsByBucket)) {
      const byRating = rankEntries(tMap, TAG_MIN_COUNT, Infinity);
      const byLeast  = rankEntriesAscending(tMap, TAG_MIN_COUNT, Infinity);
      if (byRating.length) favoriteTagByType[bucket]     = byRating;
      if (byLeast.length)  leastFavoriteTagByType[bucket] = byLeast;
    }

    // Overall person thresholds — use total review count / 10
    const totalThreshold = threshold(reviews.length);

    // ── Most reviewed variants — same data, sorted by count not avgRating ───────
    function rankByCount(map, minCount = 1, topN = 5) {
      return Object.values(map)
        .filter(entry => entry.ratings.length >= minCount)
        .map(entry => ({
          name:      entry.name,
          slug:      entry.slug || null,
          count:     entry.ratings.length,
          totalReviewCount: entry.totalReviewCount ?? entry.ratings.length,
          avgRating: entry.ratings.reduce((a, b) => a + b, 0) / entry.ratings.length,
          items:     entry.items || [],
        }))
        .sort((a, b) => b.count - a.count || b.avgRating - a.avgRating)
        .slice(0, topN);
    }

    // Return all entries with minCount=1 and no topN cap — the frontend
    // filters by the user-selected threshold dynamically without extra API
    // calls, so every candidate needs to actually be here to be considered
    // (see the topN:Infinity comment above the per-type genre ranking).
    res.json({
      totalReviews:          reviews.length,
      ignoredGenres:         target.ignoredGenres || [],
      favoriteDirectors:     rankEntries(directors, 1, Infinity),
      favoriteActors:        rankEntries(actors,    1, Infinity),
      favoriteAuthors:       rankEntries(authors,   1, Infinity),
      leastFavoriteDirectors: rankEntriesAscending(directors, 1, Infinity),
      leastFavoriteActors:    rankEntriesAscending(actors,    1, Infinity),
      leastFavoriteAuthors:   rankEntriesAscending(authors,   1, Infinity),
      leastFavoriteGenres:    rankEntriesAscending(genres,    1, Infinity),
      mostReviewedDirectors: rankByCount(directors, 1, Infinity),
      mostReviewedActors:    rankByCount(actors,    1, Infinity),
      mostReviewedAuthors:   rankByCount(authors,   1, Infinity),
      favoriteGenres:        rankEntries(genres,    1, Infinity),
      mostReviewedGenres:    rankByCount(genres,    1, Infinity),
      favoriteGenreByType,
      mostReviewedGenreByType,
      favoriteDecadeByType,
      leastFavoriteDecadeByType,
      favoriteTagByType,
      leastFavoriteTagByType,
      countByType,
      // "Condensed" Author variants — each book series the user touched
      // counts as one data point instead of one per book. See buildTasteCards
      // in profile.html for the toggle that picks between these and the
      // per-review Author fields above.
      favoriteAuthorsCondensed:     rankEntries(authorsCondensed,          1, Infinity),
      leastFavoriteAuthorsCondensed: rankEntriesAscending(authorsCondensed, 1, Infinity),
      mostReviewedAuthorsCondensed: rankByCount(authorsCondensed,          1, Infinity),
    });
  } catch (err) { next(err); }
});

// ─── GET /api/users/:username/card-data ────────────────────────────────────
// Full review set for the shareable tier-card builder (profile.html "Share
// a Card" modal). Deliberately separate from GET /:username, which caps
// reviews at take:20 as a "recent activity" preview and omits
// seriesName/seriesNumber — the tier-list card needs every review (to
// bucket by rating) plus series metadata (to group books by series and
// average the user's own ratings within one, mirroring the site-wide
// convention that the lowest seriesNumber represents the series).
// Same visibility rules as taste-profile: self always, otherwise only if
// profilePublic or friends.
router.get('/:username/card-data', optionalAuth, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({
      where: { username: req.params.username },
      select: { id: true, profilePublic: true, canceledAt: true },
    });
    if (!target || target.canceledAt) return res.status(404).json({ error: 'User not found' });

    const isSelf = req.user?.id === target.id;
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

    const reviews = await prisma.review.findMany({
      where: {
        userId: target.id,
        visibility: isSelf ? undefined : { in: ['PUBLIC', 'FRIENDS_ONLY'] },
      },
      select: {
        rating: true,
        mediaItem: {
          select: {
            id: true, title: true, slug: true, mediaType: true,
            releaseYear: true, imageUrl: true, genres: true,
            seriesName: true, seriesNumber: true,
            // TV reviews are per-season rows — parentId/parent let the card
            // builder group seasons back under their show, the same way
            // seriesName groups books under their series.
            parentId: true,
            parent: { select: { id: true, title: true, imageUrl: true } },
            cast: { select: { name: true, slug: true } },
            directors: { select: { name: true, slug: true } },
            authors: { select: { name: true, slug: true } },
          },
        },
      },
      take: 2000, // safety cap, not a real-world limit for a single user
    });

    res.json({ reviews });
  } catch (err) { next(err); }
});

// ─── GET /api/users/:username/ignored-genres ─────────────────────────────────
router.get('/:username/ignored-genres', requireAuth, async (req, res, next) => {
  try {
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ error: 'Can only view your own ignored genres' });
    }
    const user = await prisma.user.findUnique({
      where: { username: req.params.username },
      select: { ignoredGenres: true },
    });
    res.json(user?.ignoredGenres || []);
  } catch (err) { next(err); }
});

// ─── PUT /api/users/:username/ignored-genres ─────────────────────────────────
router.put('/:username/ignored-genres', requireAuth, async (req, res, next) => {
  try {
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ error: 'Can only update your own ignored genres' });
    }
    const { genres } = req.body;
    if (!Array.isArray(genres)) return res.status(400).json({ error: 'genres must be an array' });
    const user = await prisma.user.update({
      where: { username: req.params.username },
      data: { ignoredGenres: genres },
      select: { ignoredGenres: true },
    });
    res.json(user.ignoredGenres);
  } catch (err) { next(err); }
});


// ─── GET /api/users/:username/browse-prefs ────────────────────────────────────
// Returns the user's saved browse/search preferences (excludedFriends, consumedWithin)
router.get('/:username/browse-prefs', requireAuth, async (req, res, next) => {
  try {
    if (req.user.username !== req.params.username)
      return res.status(403).json({ error: 'Can only view your own preferences' });
    const user = await prisma.user.findUnique({
      where: { username: req.params.username },
      select: { excludedFriends: true, consumedWithin: true },
    });
    res.json(user || { excludedFriends: [], consumedWithin: null });
  } catch (err) { next(err); }
});

// ─── PUT /api/users/:username/browse-prefs ────────────────────────────────────
// Saves the user's browse/search preferences
router.put('/:username/browse-prefs', requireAuth, async (req, res, next) => {
  try {
    if (req.user.username !== req.params.username)
      return res.status(403).json({ error: 'Can only update your own preferences' });
    const { excludedFriends, consumedWithin } = req.body;
    const user = await prisma.user.update({
      where: { username: req.params.username },
      data: {
        excludedFriends: Array.isArray(excludedFriends) ? excludedFriends : [],
        consumedWithin:  consumedWithin || null,
      },
      select: { excludedFriends: true, consumedWithin: true },
    });
    res.json(user);
  } catch (err) { next(err); }
});


// ─── DELETE /api/users/:username ─── Cancel own account (soft) ────────────────
// This is a soft cancellation, not a hard delete. The User row and all Review
// rows are kept — star ratings stay visible and keep counting toward
// aggregate/community scores — but written review text is wiped, login is
// blocked (passwordHash/googleId cleared, and canceledAt is checked at every
// auth chokepoint: both passport strategies, requireAuth, optionalAuth), and
// the profile page 404s like the username never existed. Contrast with the
// admin spam-purge action (POST /api/admin/users/:id/spam), which hard-deletes
// everything including the ratings themselves.
router.delete('/:username', requireAuth, async (req, res, next) => {
  try {
    if (req.user.username !== req.params.username)
      return res.status(403).json({ error: 'You can only cancel your own account' });

    await prisma.$transaction([
      prisma.review.updateMany({
        where: { userId: req.user.id },
        data: { reviewText: null, spoilerText: null },
      }),
      prisma.user.update({
        where: { id: req.user.id },
        data: { canceledAt: new Date(), passwordHash: null, googleId: null },
      }),
      prisma.refreshToken.deleteMany({ where: { userId: req.user.id } }),
    ]);

    res.json({ message: 'Account canceled successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
