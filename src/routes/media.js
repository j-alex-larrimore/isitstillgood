// src/routes/media.js
const router = require('express').Router();
const { query } = require('express-validator');
const prisma = require('../lib/prisma');
const { optionalAuth } = require('../middleware/auth');
const { fetchExternalRatings } = require('../services/externalRatings');

// ─── GET /api/media ───────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res, next) => {
  const { q, type, genre, year, person, page = 1, sort = 'recent' } = req.query;
  const friendsOnly = req.query.friendsOnly === 'true';
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

    // Resolve friend IDs for friendsOnly mode
    let friendIds = [];
    if (friendsOnly && req.user) {
      const friendships = await prisma.friendship.findMany({
        where: {
          status: 'ACCEPTED',
          OR: [{ initiatorId: req.user.id }, { receiverId: req.user.id }],
        },
        select: { initiatorId: true, receiverId: true },
      });
      friendIds = friendships.map(f =>
        f.initiatorId === req.user.id ? f.receiverId : f.initiatorId
      );
      // Include self in friends-only ratings
      friendIds.push(req.user.id);
    }
    const friendFilter = friendsOnly && friendIds.length
      ? { userId: { in: friendIds } }
      : {};

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
      // For TV shows: only return parent entries (parentId = null).
      ...(type === 'TV_SHOW' && { parentId: null }),
      // For books browsing without a series filter: show standalones and unnumbered books.
      // Series books are handled separately below — we fetch all of them and deduplicate
      // to the lowest-numbered per series, then merge back before pagination.
      ...(type === 'BOOK' && !req.query.series && {
        OR: [
          { seriesName: null },    // standalone books
          { seriesNumber: null },  // unnumbered books
        ]
      }),
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
      // Series filter — shows all books in a named series
      ...(req.query.series ? { seriesName: req.query.series } : {}),
      ...(textFilter),
      ...(personFilter),
      ...(excludeReviewed && reviewedIds.length && { id: { notIn: reviewedIds } }),
      // If reviewedBy is set, restrict to items that user has reviewed
      ...(reviewedByIds !== undefined && { id: { in: reviewedByIds.length ? reviewedByIds : ['__none__'] } }),
    };

    // For 'rating' sort we can't use Prisma orderBy because avgRating is computed
    // post-fetch. Use createdAt as a stable DB sort, then re-sort by avgRating in JS.
    // 'popular' sorts by review count which Prisma can do directly.
    const orderBy = {
      popular: [{ reviews: { _count: 'desc' } }],
      recent:  [{ createdAt: 'desc' }],
      title:   [{ title: 'asc' }],
      year:    [{ releaseYear: 'desc' }],
    }[sort] || [{ createdAt: 'desc' }];

    // For book browse without series filter: fetch ONE representative per series
    // by getting all series books and deduplicating to the lowest seriesNumber.
    // This avoids pagination issues where book 2 would appear on page 2 without book 1.
    let seriesRepresentatives = [];
    if (type === 'BOOK' && !req.query.series) {
      const allSeriesEntries = await prisma.mediaItem.findMany({
        where: {
          mediaType: 'BOOK',
          seriesName: { not: null },
          seriesNumber: { not: null },
        },
        include: {
          _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
          authors: { select: { id: true, name: true, slug: true }, take: 100 },
          parent:  { select: { id: true, title: true, slug: true } },
        },
      });
      // Deduplicate to lowest seriesNumber per seriesName
      const seriesMap = new Map();
      for (const book of allSeriesEntries) {
        const existing = seriesMap.get(book.seriesName);
        if (!existing || (book.seriesNumber ?? Infinity) < (existing.seriesNumber ?? Infinity)) {
          seriesMap.set(book.seriesName, book);
        }
      }
      seriesRepresentatives = [...seriesMap.values()];
    }

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

    // Merge standalone/unnumbered books with series representatives
    let finalItems = type === 'BOOK' && !req.query.series
      ? [...items, ...seriesRepresentatives]
      : items;

    // Compute avg rating per item.
    const itemIds = finalItems.map(i => i.id);
    const tvParentIds = finalItems.filter(i => i.mediaType === 'TV_SHOW' && !i.parentId).map(i => i.id);
    const bookSeriesItems = finalItems.filter(i => i.mediaType === 'BOOK' && i.seriesName);
    const bookSeriesNames = bookSeriesItems.map(i => i.seriesName);

    const ratings = await prisma.review.groupBy({
      by: ['mediaItemId'],
      where: { mediaItemId: { in: itemIds }, visibility: 'PUBLIC', ...friendFilter },
      _avg: { rating: true },
      _count: { rating: true },
    });
    const ratingMap = Object.fromEntries(ratings.map(r => [r.mediaItemId, { avg: r._avg.rating, count: r._count.rating }]));

    let seasonCountMap = {};

    // For TV parent shows, also aggregate ratings from all child seasons
    if (tvParentIds.length) {
      const seasonRatings = await prisma.review.groupBy({
        by: ['mediaItemId'],
        where: {
          visibility: 'PUBLIC',
          mediaItem: { parentId: { in: tvParentIds } },
        },
        _avg: { rating: true },
        _count: { rating: true },
      });
      // Map season mediaItemId -> parentId, and count seasons per parent
      const seasons = await prisma.mediaItem.findMany({
        where: { parentId: { in: tvParentIds } },
        select: { id: true, parentId: true, seasonNumber: true },
      });
      const seasonToParent = Object.fromEntries(seasons.map(s => [s.id, s.parentId]));

      // Count children per parent (seasons for TV, books for book series)
      for (const s of seasons) {
        if (!s.parentId) continue;
        seasonCountMap[s.parentId] = (seasonCountMap[s.parentId] || 0) + 1;
      }

      // Accumulate season ratings per parent show
      const parentAccum = {};
      for (const r of seasonRatings) {
        const parentId = seasonToParent[r.mediaItemId];
        if (!parentId) continue;
        if (!parentAccum[parentId]) parentAccum[parentId] = { sum: 0, count: 0 };
        parentAccum[parentId].sum   += (r._avg.rating || 0) * r._count.rating;
        parentAccum[parentId].count += r._count.rating;
      }
      // Override rating map for TV parents with aggregated value
      for (const [parentId, acc] of Object.entries(parentAccum)) {
        if (acc.count > 0) {
          ratingMap[parentId] = { avg: acc.sum / acc.count, count: acc.count };
        }
      }
    }

    // For book series: count books in each series and aggregate ratings
    const bookSeriesCountMap = {};
    const bookSeriesRatingMap = {};
    if (bookSeriesNames.length) {
      const allSeriesBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: { in: bookSeriesNames } },
        select: { id: true, seriesName: true, seriesNumber: true },
      });
      // Count books per series
      for (const b of allSeriesBooks) {
        if (!b.seriesName) continue;
        bookSeriesCountMap[b.seriesName] = (bookSeriesCountMap[b.seriesName] || 0) + 1;
      }
      // Aggregate ratings for all books in each series
      const allBookIds = allSeriesBooks.map(b => b.id);
      if (allBookIds.length) {
        const bookRatings = await prisma.review.groupBy({
          by: ['mediaItemId'],
          where: { mediaItemId: { in: allBookIds }, visibility: 'PUBLIC', ...friendFilter },
          _avg: { rating: true },
          _count: { rating: true },
        });
        const bookIdToSeries = Object.fromEntries(allSeriesBooks.map(b => [b.id, b.seriesName]));
        const seriesAccum = {};
        for (const r of bookRatings) {
          const sn = bookIdToSeries[r.mediaItemId];
          if (!sn) continue;
          if (!seriesAccum[sn]) seriesAccum[sn] = { sum: 0, count: 0 };
          seriesAccum[sn].sum   += (r._avg.rating || 0) * r._count.rating;
          seriesAccum[sn].count += r._count.rating;
        }
        for (const [sn, acc] of Object.entries(seriesAccum)) {
          if (acc.count > 0) bookSeriesRatingMap[sn] = { avg: acc.sum / acc.count, count: acc.count };
        }
      }
    }

    // If sort=rating, sort finalItems by avgRating desc (items with no rating go last)
    let sortedItems = finalItems;
    if (sort === 'rating') {
      sortedItems = [...finalItems].sort((a, b) => {
        const aRating = (a.mediaType === 'BOOK' && a.seriesName && !req.query.series)
          ? (bookSeriesRatingMap[a.seriesName]?.avg || ratingMap[a.id]?.avg || 0)
          : (ratingMap[a.id]?.avg || 0);
        const bRating = (b.mediaType === 'BOOK' && b.seriesName && !req.query.series)
          ? (bookSeriesRatingMap[b.seriesName]?.avg || ratingMap[b.id]?.avg || 0)
          : (ratingMap[b.id]?.avg || 0);
        return bRating - aRating;
      });
    }

    res.json({
      items: sortedItems.map(i => {
        // For series representative cards, use aggregated series ratings
        const isSeriesCard = i.mediaType === 'BOOK' && i.seriesName && !req.query.series;
        const avg   = isSeriesCard ? (bookSeriesRatingMap[i.seriesName]?.avg   || ratingMap[i.id]?.avg)   : ratingMap[i.id]?.avg;
        const count = isSeriesCard ? (bookSeriesRatingMap[i.seriesName]?.count || ratingMap[i.id]?.count) : ratingMap[i.id]?.count;
        return {
        ...i,
        // For series representative cards, use the series name as the display title
        // so browse shows "Cradle" not "Unsouled" (the first book's actual title)
        displayTitle: isSeriesCard ? i.seriesName : undefined,
        avgRating:   avg   || null,
        reviewCount: count || 0,
        seasonCount: i.mediaType === 'TV_SHOW' && !i.parentId
          ? (seasonCountMap?.[i.id] || 0)
          : isSeriesCard
            ? (bookSeriesCountMap[i.seriesName] || 0)
            : undefined,
        reviewedByRating: req.reviewedByRatings?.[i.id] || null,
        }; // close the return object for isSeriesCard
      }),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / take),
      friendsOnly: friendsOnly && friendIds.length > 0,
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
        // For seasons: include parent show info and its cast
        parent: {
          include: {
            cast:      { select: { id: true, name: true, slug: true, imageUrl: true }, take: 100 },
            directors: { select: { id: true, name: true, slug: true }, take: 100 },
          },
        },
        // For parent shows: include child seasons ordered by season number
        seasonEntries: {
          where: { seasonNumber: { not: null } },
          select: {
            id: true, title: true, slug: true,
            seasonNumber: true, releaseYear: true, imageUrl: true,
            _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
          },
          orderBy: { seasonNumber: 'asc' },
        },
      },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });

    // For TV seasons: merge parent cast with season-specific cast.
    // Exclude any cast members listed in excludedCast (departed actors).
    // Exclusion is by name (case-insensitive) so it works even if Person IDs differ.
    if (item.parentId && item.parent?.cast?.length) {
      const seasonCastIds  = new Set((item.cast || []).map(p => p.id));
      const excluded       = new Set((item.excludedCast || []).map(n => n.toLowerCase()));
      const parentOnlyCast = item.parent.cast.filter(p =>
        !seasonCastIds.has(p.id) && !excluded.has(p.name.toLowerCase())
      );
      item.cast = [...(item.cast || []), ...parentOnlyCast];
    }
    // Also filter season's own cast against excludedCast (in case someone was
    // added to a season's cast and then added to excludedCast later)
    if (item.excludedCast?.length) {
      const excluded = new Set(item.excludedCast.map(n => n.toLowerCase()));
      item.cast = (item.cast || []).filter(p => !excluded.has(p.name.toLowerCase()));
    }

    // Is this a TV parent show?
    const isTvParent = item.mediaType === 'TV_SHOW' && !item.parentId;

    // Is this a book that is the lowest-numbered in its series?
    // If so, treat it as the series page showing all books in that series.
    // We check dynamically so if a lower-numbered book is added later,
    // it automatically becomes the series page.
    let isBookSeries = false;
    let seriesRepSlug = null;
    if (item.mediaType === 'BOOK' && item.seriesName && item.seriesNumber != null) {
      const lowestInSeries = await prisma.mediaItem.findFirst({
        where: { mediaType: 'BOOK', seriesName: item.seriesName, seriesNumber: { not: null } },
        orderBy: { seriesNumber: 'asc' },
        select: { id: true, slug: true },
      });
      // ?book=1 means "show this as an individual book" even if it's the series representative
      const forceIndividual = req.query.book === '1';
      isBookSeries  = !forceIndividual && lowestInSeries?.id === item.id;
      seriesRepSlug = lowestInSeries?.slug || null;
    }
    const isSeriesParent = isTvParent || isBookSeries;

    // If a TV parent has exactly one season, redirect straight to it
    if (isTvParent && item.seasonEntries?.length === 1) {
      const onlySeason = item.seasonEntries[0];
      return res.json({ redirect: `/item.html?slug=${onlySeason.slug}` });
    }

    // For TV parent shows and book series, aggregate stats across all entries
    let statsWhere = { mediaItemId: item.id, visibility: 'PUBLIC' };
    let seriesBooks = [];

    if (isTvParent && item.seasonEntries?.length) {
      const seasonIds = item.seasonEntries.map(s => s.id);
      statsWhere = { mediaItemId: { in: seasonIds }, visibility: 'PUBLIC' };
    } else if (isBookSeries && item.seriesName) {
      // Fetch all books in this series ordered by seriesNumber
      seriesBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: item.seriesName },
        select: {
          id: true, title: true, slug: true,
          seriesNumber: true, releaseYear: true, imageUrl: true,
          _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
        },
        orderBy: { seriesNumber: 'asc' },
      });
      const seriesBookIds = seriesBooks.map(b => b.id);
      statsWhere = { mediaItemId: { in: seriesBookIds }, visibility: 'PUBLIC' };
    }

    const stats = await prisma.review.aggregate({
      where: statsWhere,
      _avg: { rating: true }, _count: { rating: true },
    });

    const verdicts = await prisma.review.groupBy({
      by: ['verdict'],
      where: statsWhere,
      _count: { verdict: true },
    });

    // Add avg rating to each season/book for the picker
    if (isTvParent && item.seasonEntries?.length) {
      const seasonIds = item.seasonEntries.map(s => s.id);
      const seasonRatings = await prisma.review.groupBy({
        by: ['mediaItemId'],
        where: { mediaItemId: { in: seasonIds }, visibility: 'PUBLIC' },
        _avg: { rating: true },
        _count: { rating: true },
      });
      const srMap = Object.fromEntries(seasonRatings.map(r => [r.mediaItemId, { avg: r._avg.rating, count: r._count.rating }]));
      item.seasonEntries = item.seasonEntries.map(s => ({
        ...s,
        avgRating:   srMap[s.id]?.avg   || null,
        reviewCount: srMap[s.id]?.count || 0,
      }));
    }
    // For book series: enrich the series books list with ratings
    if (isBookSeries && seriesBooks.length) {
      const bookIds = seriesBooks.map(b => b.id);
      const bookRatings = await prisma.review.groupBy({
        by: ['mediaItemId'],
        where: { mediaItemId: { in: bookIds }, visibility: 'PUBLIC' },
        _avg: { rating: true },
        _count: { rating: true },
      });
      const brMap = Object.fromEntries(bookRatings.map(r => [r.mediaItemId, { avg: r._avg.rating, count: r._count.rating }]));
      seriesBooks = seriesBooks.map(b => ({
        ...b,
        avgRating:   brMap[b.id]?.avg   || null,
        reviewCount: brMap[b.id]?.count || 0,
      }));
      // Attach series books to item for the frontend
      item.seriesBooksData = seriesBooks;
    }

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
      isTvParent,
      isBookSeries,
      isSeriesParent,
      seriesBooksData: item.seriesBooksData || null,
      seriesRepSlug,
      communityStats: {
        avgRating:   stats._avg.rating,
        reviewCount: stats._count.rating,
        verdicts:    Object.fromEntries(verdicts.map(v => [v.verdict, v._count.verdict])),
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
