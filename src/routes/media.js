// src/routes/media.js
const router = require('express').Router();
const { query } = require('express-validator');
const prisma = require('../lib/prisma');
const { optionalAuth } = require('../middleware/auth');
const { fetchExternalRatings } = require('../services/externalRatings');

// ─── GET /api/media ───────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res, next) => {
  const { q, type, genre, year, person, page = 1, sort = 'recent' } = req.query;
  // qScope narrows what the `q` text search matches against — 'keyword'
  // (default, unchanged) searches title/description/seriesName/person
  // names; 'title' restricts to title+seriesName only. Added because a
  // spam-stuffed description (e.g. a self-published book listing dozens of
  // unrelated famous titles/authors "fans of X will enjoy this") could
  // surface in a search for any of those names — title-only search sidesteps
  // that class of noise entirely.
  const qScope = req.query.qScope === 'title' ? 'title' : 'keyword';
  const friendsOnly      = req.query.friendsOnly === 'true';
  // excludeFriends: comma-separated usernames to exclude from friend ratings
  const excludeFriends   = req.query.excludeFriends
    ? req.query.excludeFriends.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  // consumedWithin: only count reviews where dateConsumed >= N months ago
  // Format: "12m" = 12 months, "2y" = 2 years
  const consumedWithin   = req.query.consumedWithin || null;
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
      // Support comma-separated names — each term must match at least one person
      // and ALL matched persons must appear in the item (AND logic across terms)
      const terms = person.split(',').map(t => t.trim()).filter(Boolean);
      const termFilters = [];
      for (const term of terms) {
        const persons = await prisma.person.findMany({
          where: { name: { contains: term, mode: 'insensitive' } },
          select: { id: true },
        });
        if (!persons.length) {
          // If any term matches nobody, no results possible
          return res.json({ items: [], total: 0, page: parseInt(page), pages: 0 });
        }
        const ids = persons.map(p => p.id);
        termFilters.push({
          OR: [
            { directors: { some: { id: { in: ids } } } },
            { cast:      { some: { id: { in: ids } } } },
            { authors:   { some: { id: { in: ids } } } },
          ],
        });
      }
      // AND all term filters — item must feature all named people
      personFilter = termFilters.length === 1 ? termFilters[0] : { AND: termFilters };
    }

    // Genre search — check both genres array and title/description
    let genreFilter = undefined;
    if (genre && genre.trim().length > 0) {
      genreFilter = { genres: { has: genre.trim() } };
    }

    // Text search across title, description, series name — or, when
    // qScope is 'title', just title/seriesName (see comment above).
    let textFilter = undefined;
    if (q && q.trim().length > 0) {
      textFilter = qScope === 'title' ? {
        OR: [
          { title:      { contains: q.trim(), mode: 'insensitive' } },
          { seriesName: { contains: q.trim(), mode: 'insensitive' } },
        ],
      } : {
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

    // Resolve friend IDs for friendsOnly mode, minus any excluded friends
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
      friendIds.push(req.user.id);

      // Apply excluded friends — look up their user IDs by username
      if (excludeFriends.length) {
        const excluded = await prisma.user.findMany({
          where: { username: { in: excludeFriends } },
          select: { id: true },
        });
        const excludedIds = new Set(excluded.map(u => u.id));
        friendIds = friendIds.filter(id => !excludedIds.has(id));
      }
    }
    const friendFilter = friendsOnly && friendIds.length
      ? { userId: { in: friendIds } }
      : {};

    // Build dateConsumed cutoff for consumedWithin filter
    let consumedCutoff = null;
    if (consumedWithin) {
      const match = consumedWithin.match(/^(\d+)(m|y)$/);
      if (match) {
        const n    = parseInt(match[1]);
        const unit = match[2];
        const d    = new Date();
        if (unit === 'm') d.setMonth(d.getMonth() - n);
        else              d.setFullYear(d.getFullYear() - n);
        consumedCutoff = d;
      }
    }
    const consumedFilter = consumedCutoff
      ? { dateConsumed: { gte: consumedCutoff } }
      : {};

    // Excluded already-reviewed items
    let reviewedIds = [];
    if (excludeReviewed) {
      const reviewed = await prisma.review.findMany({
        where: { userId: req.user.id },
        select: { mediaItemId: true },
      });
      const directIds = reviewed.map(r => r.mediaItemId);

      // For TV shows, reviews are written on seasons (children).
      // Only exclude the parent show if ALL of its seasons have been reviewed.
      const reviewedSeasons = await prisma.mediaItem.findMany({
        where: { id: { in: directIds }, parentId: { not: null } },
        select: { parentId: true },
      });

      // Group reviewed seasons by parent
      const reviewedByParent = {};
      for (const { parentId } of reviewedSeasons) {
        reviewedByParent[parentId] = (reviewedByParent[parentId] || 0) + 1;
      }

      // Count total seasons per parent show
      const parentIds = Object.keys(reviewedByParent);
      const fullyReviewedParentIds = [];
      if (parentIds.length) {
        const seasonCounts = await prisma.mediaItem.groupBy({
          by: ['parentId'],
          where: { parentId: { in: parentIds } },
          _count: { id: true },
        });
        for (const { parentId, _count } of seasonCounts) {
          if (reviewedByParent[parentId] >= _count.id) {
            fullyReviewedParentIds.push(parentId);
          }
        }
      }

      reviewedIds = [...new Set([...directIds, ...fullyReviewedParentIds])];
    }

    // Build where clause using AND array to avoid OR key collisions when
    // multiple OR-based filters (textFilter, personFilter, book series) are combined.
    // verified:true always applies here — this is the public browse/search endpoint,
    // items awaiting admin review (scripts/bulk-import.js, admin bulk-import) are
    // reviewed via GET /api/admin/media/pending instead, not this route.
    const andClauses = [{ verified: true }];

    if (type)                             andClauses.push({ mediaType: type });
    // TV filtering: normally show only parent shows (parentId: null).
    // BUT when searching by person/text (which can match an actor), also allow
    // seasons — a guest actor in one season should surface that specific season.
    // We dedupe below: if the parent show already matches, we drop its seasons.
    const tvPersonSearch = (personFilter || (textFilter && q)) && type === 'TV_SHOW';
    if (type === 'TV_SHOW' && !req.query.individual && !tvPersonSearch) {
      andClauses.push({ parentId: null });
    }
    if (type === 'TV_SHOW' && req.query.individual)  andClauses.push({ parentId: { not: null } });
    if (type === 'BOOK' && !req.query.series && !req.query.individual) {
      // When text search is active, series books will be handled individually
      // if multiple from same series match — otherwise via seriesRepresentatives
      // Only apply the standalone-books filter when no text search.
      // Deliberately just seriesName: null, NOT seriesNumber: null too — a
      // companion/interstitial volume (seriesNumber left null on purpose,
      // per the site-wide convention for books like "1.5") still has a real
      // seriesName, so treating null-seriesNumber as "standalone" let those
      // leak into Browse as orphaned individual cards outside their series
      // — confirmed live with two Murderbot Diaries novellas ("Home",
      // "Rapport") showing up ahead of the actual series card.
      if (!q) andClauses.push({ seriesName: null });
    }
    if (year && !req.query.yearFrom && !req.query.yearTo) {
      andClauses.push({ releaseYear: parseInt(year) });
    }
    if (req.query.yearFrom || req.query.yearTo) {
      andClauses.push({ releaseYear: {
        ...(req.query.yearFrom ? { gte: parseInt(req.query.yearFrom) } : {}),
        ...(req.query.yearTo   ? { lte: parseInt(req.query.yearTo)   } : {}),
      }});
    }
    if (genreFilter)    andClauses.push(genreFilter);
    let tagVariants = [];
    if (req.query.tag) {
      const rawTag   = req.query.tag.trim();
      const lower    = rawTag.toLowerCase();
      const titleCase = rawTag.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      // Also normalize through TAG_OVERRIDES so "hbo" matches "HBO", "apple tv" matches "Apple TV" etc.
      const TAG_OVERRIDES = {
        'hbo':'HBO','hbo max':'HBO Max','apple tv':'Apple TV','apple tv+':'Apple TV+',
        'nbc':'NBC','cbs':'CBS','abc':'ABC','amc':'AMC','fx':'FX','bbc':'BBC','pbs':'PBS',
        'mtv':'MTV','usa':'USA','tnt':'TNT','tbs':'TBS','syfy':'Syfy','espn':'ESPN',
        'nfl':'NFL','nba':'NBA','mlb':'MLB','nhl':'NHL','dc':'DC','mcu':'MCU','uk':'UK',
      };
      const normalized = TAG_OVERRIDES[lower]
        || rawTag.split(' ').map(w => TAG_OVERRIDES[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
      // Build a deduplicated set of variants to check
      tagVariants = [...new Set([rawTag, lower, titleCase, normalized])];
      andClauses.push({ tags: { hasSome: tagVariants } });
    }
    if (req.query.series)   andClauses.push({ seriesName: req.query.series });
    if (textFilter)         andClauses.push(textFilter);
    if (personFilter)       andClauses.push(personFilter);
    if (excludeReviewed && reviewedIds.length) andClauses.push({ id: { notIn: reviewedIds } });
    if (reviewedByIds !== undefined) andClauses.push({ id: { in: reviewedByIds.length ? reviewedByIds : ['__none__'] } });
    if (!type) andClauses.push({ NOT: { AND: [{ mediaType: 'TV_SHOW' }, { parentId: null }] } });

    const where = andClauses.length > 0 ? { AND: andClauses } : {};

    // For 'rating' sort we can't use Prisma orderBy because avgRating is computed
    // post-fetch. Use createdAt as a stable DB sort, then re-sort by avgRating in JS.
    // 'popular' sorts by review count which Prisma can do directly.
    const orderBy = {
      popular: [{ reviews: { _count: 'desc' } }],
      recent:  [{ createdAt: 'desc' }],
      title:   [{ title: 'asc' }],
      year:    [{ releaseYear: 'asc' }],
    }[sort] || [{ createdAt: 'desc' }];

    // For book browse without series filter: fetch ONE representative per series
    // by getting all series books and deduplicating to the lowest seriesNumber.
    // This avoids pagination issues where book 2 would appear on page 2 without book 1.
    // IMPORTANT: Apply the same filters (person, genre, tag, text) so searching for an
    // author doesn't return series by unrelated authors.
    // Also runs for an untyped (all-media) text search — not just type=BOOK — so
    // searching "Jordan" without narrowing to Books still collapses Wheel of Time
    // to one series card instead of 15 individual books. Untyped browse (no q) is
    // left alone since that's an edge case with no reported problem, and collapsing
    // it would require also generalizing the standalone-books andClauses restriction.
    const collapseBookSeries = (type === 'BOOK' || (!type && q)) && !req.query.series && !req.query.individual && !reviewedBy;
    let seriesRepresentatives = [];
    let allSeriesEntries = [];
    let seriesCountMap = new Map();
    if (collapseBookSeries) {
      // Build a series-specific where clause that includes all active filters
      const seriesWhereClauses = [
        { mediaType: 'BOOK' },
        { verified: true },
        { seriesName: { not: null } },
        { seriesNumber: { not: null } },
      ];
      if (genreFilter)    seriesWhereClauses.push(genreFilter);
      if (textFilter)     seriesWhereClauses.push(textFilter);
      if (personFilter)   seriesWhereClauses.push(personFilter);
      if (req.query.tag)  seriesWhereClauses.push({ tags: { hasSome: tagVariants } });

      allSeriesEntries = await prisma.mediaItem.findMany({
        where: { AND: seriesWhereClauses },
        include: {
          _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
          authors: { select: { id: true, name: true, slug: true }, take: 100 },
          parent:  { select: { id: true, title: true, slug: true } },
        },
      });
        // Deduplicate to lowest seriesNumber per seriesName
      // BUT: if a text search returns multiple books from the same series,
      // show them individually rather than collapsing to the representative.
      seriesCountMap = new Map();
      for (const book of allSeriesEntries) {
        seriesCountMap.set(book.seriesName, (seriesCountMap.get(book.seriesName) || 0) + 1);
      }

      const seriesMap = new Map();
      for (const book of allSeriesEntries) {
        const existing = seriesMap.get(book.seriesName);
        if (!existing || (book.seriesNumber ?? Infinity) < (existing.seriesNumber ?? Infinity)) {
          seriesMap.set(book.seriesName, book);
        }
      }
      seriesRepresentatives = [...seriesMap.values()];
    }

    // For rating/lowest sort: fetch ALL items so we can sort them together
    // and paginate in JS. This ensures unrated items always appear at the bottom
    // of the last page rather than being pushed off by pagination.
    const ratingSort = sort === 'rating' || sort === 'lowest';
    // When a text query is active, results need a relevance pass in JS too —
    // otherwise the chosen sort (recency, rating, etc.) is the ONLY ordering,
    // and since most items in a fresh catalog have zero reviews, "Top Rated"
    // (the default) degenerates to no-op ties broken by DB fetch order. That's
    // exactly why searching "halo" surfaced unrelated zero-review items above
    // the actual Halo games — confirmed live. Fetch everything matching so the
    // relevance sort below can consider the whole result set before paginating.
    const textActive = !!(q && q.trim().length > 0);
    const fullFetchMode = ratingSort || textActive;

    const [items, total] = await Promise.all([
      prisma.mediaItem.findMany({
        where,
        include: {
          _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
          directors: { select: { id: true, name: true, slug: true }, take: 100 },
          authors:   { select: { id: true, name: true, slug: true }, take: 100 },
          cast:      { select: { id: true, name: true, slug: true }, take: 100 },
          parent:    { select: { id: true, title: true, slug: true } },
        },
        orderBy,
        // For rating sort (or any text search), fetch all — pagination handled in JS after sort
        skip: fullFetchMode ? 0 : (parseInt(page) - 1) * take,
        take: fullFetchMode ? undefined : take,
      }),
      prisma.mediaItem.count({ where }),
    ]);
    const bookRatingSort = ratingSort && collapseBookSeries;

    // Merge standalone/unnumbered books with series representatives
    let finalItems;
    if (collapseBookSeries) {
      // Always remove series reps from items — they come through seriesRepresentatives
      // This prevents duplicates whether searching or browsing
      const seriesRepIds = new Set(seriesRepresentatives.map(r => r.id));
      const dedupedItems = items.filter(i => !seriesRepIds.has(i.id));

      if (q) {
        const qLower = q.toLowerCase();
        // An individual book card should only appear when the query matches the
        // book's OWN title — NOT its description, author, or series name. Deliberately
        // excludes description: Google Books blurbs routinely credit the author by name
        // ("...Robert Jordan's #1 New York Times bestselling epic fantasy series...")
        // and often mention the series name too, so an author/series search like "Jordan"
        // would match nearly every book's description and defeat the whole point of
        // collapsing to a series card — confirmed live against the Wheel of Time books.
        const matchesBookText = (b) => b.title && b.title.toLowerCase().includes(qLower);

        // Non-rep series books: keep only those whose own title/description matched
        const individualBooks = dedupedItems.filter(b =>
          !b.seriesName || matchesBookText(b)
        );

        // The series representative is never re-added as a second "individual"
        // card here — it already appears via seriesRepresentatives below, and
        // that card IS this exact book (its own page is one click away via the
        // series page's "?book=1" override). Confirmed live: The Wandering Inn's
        // book 1 shares its title with the series name, so re-adding it as a
        // separate individual match produced two identical-looking result cards.
        finalItems = [...individualBooks, ...seriesRepresentatives];
      } else {
        finalItems = [...dedupedItems, ...seriesRepresentatives];
      }
    } else {
      finalItems = items;
    }

    // TV person search: if both a parent show AND its seasons matched (e.g. actor is
    // main cast so the show matches, and also in specific seasons), keep only the parent
    // show and drop its seasons to avoid clutter. Seasons whose parent did NOT match
    // (guest actor not in main cast) are kept.
    if (tvPersonSearch) {
      const matchedParentIds = new Set(
        finalItems.filter(i => i.mediaType === 'TV_SHOW' && !i.parentId).map(i => i.id)
      );
      finalItems = finalItems.filter(i =>
        !(i.parentId && matchedParentIds.has(i.parentId))
      );
    }

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
    // Keep direct ratings (series-level reviews) before TV aggregation overwrites them
    const directRatingMap = { ...ratingMap };

    let seasonCountMap = {};

    let tvCompletionMap = {};
    // For TV parent shows, aggregate ratings from all child seasons.
    // Skip this expensive aggregation when filtering by reviewedBy — just use direct ratings.
    if (tvParentIds.length && !reviewedBy) {
      const seasons = await prisma.mediaItem.findMany({
        where: { parentId: { in: tvParentIds } },
        select: { id: true, parentId: true },
      });
      const seasonIds = seasons.map(s => s.id);
      const seasonToParent = Object.fromEntries(seasons.map(s => [s.id, s.parentId]));

      // Count seasons per parent
      for (const s of seasons) {
        if (!s.parentId) continue;
        seasonCountMap[s.parentId] = (seasonCountMap[s.parentId] || 0) + 1;
      }

      if (seasonIds.length) {
        const seasonRatings = await prisma.review.groupBy({
          by: ['mediaItemId'],
          where: {
            mediaItemId: { in: seasonIds },
            visibility: 'PUBLIC',
            ...friendFilter,
            ...consumedFilter,
          },
          _avg: { rating: true },
          _count: { rating: true },
        });

        const parentAccum = {};
        for (const r of seasonRatings) {
          const parentId = seasonToParent[r.mediaItemId];
          if (!parentId) continue;
          if (!parentAccum[parentId]) parentAccum[parentId] = { sum: 0, count: 0 };
          parentAccum[parentId].sum   += (r._avg.rating || 0) * r._count.rating;
          parentAccum[parentId].count += r._count.rating;
        }
        for (const [parentId, acc] of Object.entries(parentAccum)) {
          if (acc.count > 0) {
            ratingMap[parentId] = { avg: acc.sum / acc.count, count: acc.count };
          }
        }

        // Average completion: avg number of seasons reviewed per user (who reviewed at least one)
        // Get all season reviews for these parent shows to group by user
        tvCompletionMap = {}; // reset before populating
        if (seasonIds.length) {
          const allSeasonReviews = await prisma.review.findMany({
            where: {
              mediaItemId: { in: seasonIds },
              visibility: 'PUBLIC',
              ...friendFilter,
            },
            select: { userId: true, mediaItemId: true },
          });
          // Group: parentId -> userId -> set of season ids reviewed
          const byParentByUser = {};
          for (const r of allSeasonReviews) {
            const parentId = seasonToParent[r.mediaItemId];
            if (!parentId) continue;
            if (!byParentByUser[parentId]) byParentByUser[parentId] = {};
            if (!byParentByUser[parentId][r.userId]) byParentByUser[parentId][r.userId] = new Set();
            byParentByUser[parentId][r.userId].add(r.mediaItemId);
          }
          for (const [parentId, userMap] of Object.entries(byParentByUser)) {
            const userCounts = Object.values(userMap).map(s => s.size);
            const avgCompletion = userCounts.reduce((a, b) => a + b, 0) / userCounts.length;
            tvCompletionMap[parentId] = {
              avg: Math.round(avgCompletion * 10) / 10,
              total: seasonCountMap[parentId] || 0,
              reviewerCount: userCounts.length,
            };
          }
        }
      }
    }

    // For book series: count books in each series and aggregate ratings
    const bookSeriesCountMap = {};
    let bookCompletionMap = {};
    const bookSeriesRatingMap = {};
    if (bookSeriesNames.length && !reviewedBy) {
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
          where: { mediaItemId: { in: allBookIds }, visibility: 'PUBLIC', ...friendFilter, ...consumedFilter },
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

        // Average completion: avg number of books reviewed per user (who reviewed at least one)
        bookCompletionMap = {}; // reset before populating
        const allBookReviews = await prisma.review.findMany({
          where: {
            mediaItemId: { in: allBookIds },
            visibility: 'PUBLIC',
            ...friendFilter,
          },
          select: { userId: true, mediaItemId: true },
        });
        const bySeriesByUser = {};
        for (const r of allBookReviews) {
          const sn = bookIdToSeries[r.mediaItemId];
          if (!sn) continue;
          if (!bySeriesByUser[sn]) bySeriesByUser[sn] = {};
          if (!bySeriesByUser[sn][r.userId]) bySeriesByUser[sn][r.userId] = new Set();
          bySeriesByUser[sn][r.userId].add(r.mediaItemId);
        }
        for (const [sn, userMap] of Object.entries(bySeriesByUser)) {
          const userCounts = Object.values(userMap).map(s => s.size);
          const avgCompletion = userCounts.reduce((a, b) => a + b, 0) / userCounts.length;
          bookCompletionMap[sn] = {
            avg: Math.round(avgCompletion * 10) / 10,
            total: bookSeriesCountMap[sn] || 0,
            reviewerCount: userCounts.length,
          };
        }
      }
    }

    // Helper to get the effective rating for an item (series aggregate or individual).
    // Only the actual series-representative card gets the series-wide aggregate —
    // any other book sharing that seriesName (e.g. a companion novella shown
    // individually) must sort by its own rating. Previously this checked only
    // `i.seriesName` truthy, so an unrated companion book inherited its whole
    // series' aggregate rating for sort purposes while still *displaying* "No
    // reviews yet" (that part already correctly checked isSeriesRep) — the
    // mismatch put unrated books ahead of genuinely-rated ones under Top Rated.
    function effectiveRating(i) {
      const isRep = seriesRepresentatives.some(r => r.id === i.id);
      return (i.mediaType === 'BOOK' && i.seriesName && !req.query.series && !req.query.individual && isRep)
        ? (bookSeriesRatingMap[i.seriesName]?.avg || ratingMap[i.id]?.avg || null)
        : (ratingMap[i.id]?.avg || null);
    }

    // Relevance tier for a text query — checked first against the item's own
    // title and (for book series cards) the series name, since that's what's
    // actually displayed to the user. If neither matches, an author/director/
    // cast name containing the query still ranks above a match that only came
    // from the description — confirmed live that an author search (e.g. an
    // author's surname) should surface their books above unrelated titles
    // that merely mention the name in passing text. Within that person-name
    // tier, a complete first/last/middle name match outranks a mere substring
    // match — confirmed live that searching "anders" should surface Charlie
    // Jane Anders (a real name token) above Sanderson (which just happens to
    // contain the letters "anders" mid-word). 0 means the match came from
    // somewhere else entirely (description only).
    const qLower = textActive ? q.trim().toLowerCase() : null;
    const qWordRe = textActive ? new RegExp(`\\b${qLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : null;
    function relevance(i) {
      if (!textActive) return 0;
      const candidates = [i.title, i.seriesName].filter(Boolean).map(s => s.toLowerCase());
      let best = 0;
      for (const c of candidates) {
        if (c === qLower)              best = Math.max(best, 4);
        else if (c.startsWith(qLower)) best = Math.max(best, 3);
        else if (c.includes(qLower))   best = Math.max(best, 2);
      }
      if (best === 0) {
        const people = [...(i.authors || []), ...(i.directors || []), ...(i.cast || [])];
        for (const p of people) {
          if (!p.name) continue;
          const nameLower = p.name.toLowerCase();
          if (qWordRe.test(nameLower))        best = Math.max(best, 1);
          else if (nameLower.includes(qLower)) best = Math.max(best, 0.5);
        }
      }
      return best;
    }

    // Secondary ordering key — whatever the user's chosen sort represents —
    // used only to break ties within the same relevance tier.
    function secondaryKey(i) {
      switch (sort) {
        case 'rating': case 'lowest': return effectiveRating(i);
        case 'popular': return i._count?.reviews ?? 0;
        case 'year':    return i.releaseYear ?? null;
        case 'title':   return (i.title || '').toLowerCase();
        case 'recent':  default: return new Date(i.createdAt).getTime();
      }
    }
    function compareSecondary(a, b) {
      const aKey = secondaryKey(a), bKey = secondaryKey(b);
      if (sort === 'title') return String(aKey).localeCompare(String(bKey));
      // Nulls (no rating / no year) always sort last regardless of direction
      if (aKey === null && bKey === null) return 0;
      if (aKey === null) return 1;
      if (bKey === null) return -1;
      return sort === 'lowest' || sort === 'year' ? aKey - bKey : bKey - aKey;
    }

    // Sort ALL matching items together (series + standalones) then paginate in JS —
    // required whenever avgRating drives the order (computed post-fetch) or a text
    // query is active (relevance can't be expressed as a DB-level orderBy).
    let sortedItems = finalItems;
    if (textActive) {
      sortedItems = [...finalItems].sort((a, b) => {
        const relDiff = relevance(b) - relevance(a);
        return relDiff !== 0 ? relDiff : compareSecondary(a, b);
      });
      const pageNum = parseInt(page) - 1;
      sortedItems = sortedItems.slice(pageNum * take, (pageNum + 1) * take);
    } else if (sort === 'rating' || sort === 'lowest') {
      sortedItems = [...finalItems].sort(compareSecondary);
      // Re-apply pagination after sorting
      const pageNum = parseInt(page) - 1;
      sortedItems = sortedItems.slice(pageNum * take, (pageNum + 1) * take);
    }

    res.json({
      items: sortedItems.map(i => {
        // For series representative cards, use aggregated series ratings
        // A book is a series card if it's the series representative (lowest seriesNumber in series)
        // When text search active, series cards use individual book rating, not series aggregate
        const isSeriesRep = seriesRepresentatives.some(r => r.id === i.id);
        const isSeriesCard = i.mediaType === 'BOOK' && i.seriesName && !req.query.series && !req.query.individual && isSeriesRep;
        const isTvParentCard = i.mediaType === 'TV_SHOW' && !i.parentId;

        // avgRating: series-level reviews (written about the whole series/show)
        // For book series cards: direct reviews of the first book (series rep)
        // For TV parent cards: direct reviews of the show parent item
        // For individual items: their own reviews
        const avg   = isSeriesCard ? (directRatingMap[i.id]?.avg   || null) : ratingMap[i.id]?.avg;
        const count = isSeriesCard ? (directRatingMap[i.id]?.count || 0)    : ratingMap[i.id]?.count;

        // seriesAvgRating: aggregate of all books/seasons (only for series cards)
        const seriesAvgRating = isSeriesCard
          ? (bookSeriesRatingMap[i.seriesName]?.avg || null)
          : isTvParentCard
            ? (ratingMap[i.id]?.avg || null)  // ratingMap for TV parents = season aggregate
            : undefined;

        return {
        ...i,
        // Series cards always show the series name as their title
        displayTitle: isSeriesCard ? i.seriesName : undefined,
        isSeries: isSeriesCard || undefined,
        avgRating:   avg   || null,
        reviewCount: count || 0,
        seriesAvgRating,
        seasonCount: i.mediaType === 'TV_SHOW' && !i.parentId
          ? (seasonCountMap?.[i.id] || 0)
          : isSeriesCard
            ? (bookSeriesCountMap[i.seriesName] || 0)
            : undefined,
        avgCompletion: i.mediaType === 'TV_SHOW' && !i.parentId
          ? (tvCompletionMap?.[i.id] || null)
          : isSeriesCard
            ? (bookCompletionMap?.[i.seriesName] || null)
            : undefined,
        reviewedByRating: req.reviewedByRatings?.[i.id] || null,
        }; // close the return object for isSeriesCard
      }),
      // For rating sort, total reflects the full sorted set (including series reps for books)
      total: fullFetchMode ? finalItems.length : total,
      page: parseInt(page),
      pages: fullFetchMode ? Math.ceil(finalItems.length / take) : Math.ceil(total / take),
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
          where: { seasonNumber: { not: null }, verified: true },
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
    // Items awaiting admin review aren't publicly reachable — same as if they
    // didn't exist. Review happens via GET /api/admin/media/pending instead.
    if (!item.verified) return res.status(404).json({ error: 'Not found' });

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
        where: { mediaType: 'BOOK', seriesName: item.seriesName, seriesNumber: { not: null }, verified: true },
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
    // Series-level reviews: for book series use seasonNumber:0, for TV use seasonNumber:null
    const seriesLevelWhere = isBookSeries
      ? { mediaItemId: item.id, seasonNumber: 0, visibility: 'PUBLIC' }
      : { mediaItemId: item.id, seasonNumber: null, visibility: 'PUBLIC' };
    let statsWhere = { mediaItemId: item.id, visibility: 'PUBLIC' };
    let seriesBooks = [];

    if (isTvParent && item.seasonEntries?.length) {
      const seasonIds = item.seasonEntries.map(s => s.id);
      statsWhere = { mediaItemId: { in: seasonIds }, visibility: 'PUBLIC' };
    } else if (isBookSeries && item.seriesName) {
      // Fetch all books in this series ordered by seriesNumber
      seriesBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: item.seriesName, verified: true },
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

    const [stats, seriesLevelStats] = await Promise.all([
      prisma.review.aggregate({
        where: statsWhere,
        _avg: { rating: true }, _count: { rating: true },
      }),
      // Series-level reviews (written directly about the series/show as a whole)
      isSeriesParent ? prisma.review.aggregate({
        where: seriesLevelWhere,
        _avg: { rating: true }, _count: { rating: true },
      }) : Promise.resolve(null),
    ]);

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
      // For book series pages, series-level reviews use seasonNumber: 0
      // For TV parent shows, series-level reviews use seasonNumber: null
      // For individual books and all other items, seasonNumber: null
      const seriesReviewWhere = isBookSeries
        ? { userId: req.user.id, mediaItemId: item.id, seasonNumber: 0 }
        : { userId: req.user.id, mediaItemId: item.id, seasonNumber: null };
      userReview = await prisma.review.findFirst({ where: seriesReviewWhere });
    }

    // Compute average completion for TV parent shows and book series
    let avgCompletion = null;
    if (isTvParent && item.seasonEntries?.length) {
      const seasonIds = item.seasonEntries.map(s => s.id);
      const allSeasonReviews = await prisma.review.findMany({
        where: { mediaItemId: { in: seasonIds }, visibility: 'PUBLIC' },
        select: { userId: true, mediaItemId: true },
      });
      const byUser = {};
      for (const r of allSeasonReviews) {
        if (!byUser[r.userId]) byUser[r.userId] = new Set();
        byUser[r.userId].add(r.mediaItemId);
      }
      const userCounts = Object.values(byUser).map(s => s.size);
      if (userCounts.length) {
        const avg = userCounts.reduce((a, b) => a + b, 0) / userCounts.length;
        avgCompletion = {
          avg: Math.round(avg * 10) / 10,
          total: item.seasonEntries.length,
          reviewerCount: userCounts.length,
        };
      }
    } else if (isBookSeries && seriesBooks.length) {
      const bookIds = seriesBooks.map(b => b.id);
      const allBookReviews = await prisma.review.findMany({
        where: { mediaItemId: { in: bookIds }, visibility: 'PUBLIC' },
        select: { userId: true, mediaItemId: true },
      });
      const byUser = {};
      for (const r of allBookReviews) {
        if (!byUser[r.userId]) byUser[r.userId] = new Set();
        byUser[r.userId].add(r.mediaItemId);
      }
      const userCounts = Object.values(byUser).map(s => s.size);
      if (userCounts.length) {
        const avg = userCounts.reduce((a, b) => a + b, 0) / userCounts.length;
        avgCompletion = {
          avg: Math.round(avg * 10) / 10,
          total: seriesBooks.length,
          reviewerCount: userCounts.length,
        };
      }
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
        avgRating:    stats._avg.rating,
        reviewCount:  stats._count.rating,
        verdicts:     Object.fromEntries(verdicts.map(v => [v.verdict, v._count.verdict])),
        avgCompletion,
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

    // Friends-only filter — restrict to reviews by friends of the logged-in user
    let userFilter = {};
    const friendsOnly      = req.query.friendsOnly === 'true';
  // excludeFriends: comma-separated usernames to exclude from friend ratings
  const excludeFriends   = req.query.excludeFriends
    ? req.query.excludeFriends.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  // consumedWithin: only count reviews where dateConsumed >= N months ago
  // Format: "12m" = 12 months, "2y" = 2 years
  const consumedWithin   = req.query.consumedWithin || null;
    if (friendsOnly && req.user) {
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
      userFilter = { userId: { in: friendIds.length ? friendIds : ['__none__'] } };
    }

    const visibilityFilter = (friendsOnly && req.user)
      ? { in: ['PUBLIC', 'FRIENDS_ONLY'] }
      : 'PUBLIC';

    const where = { mediaItemId: item.id, visibility: visibilityFilter, ...seasonFilter, ...userFilter };
    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          reactions: { select: { userId: true, emoji: true } },
          _count: { select: { reactions: true, comments: true } },
        },
        orderBy: req.query.sort === 'top' ? [{ reactions: { _count: 'desc' } }] : [{ createdAt: 'desc' }],
        skip: (page - 1) * take, take,
      }),
      prisma.review.count({ where }),
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
