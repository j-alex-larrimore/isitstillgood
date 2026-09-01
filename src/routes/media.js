// src/routes/media.js
const router = require('express').Router();
const { query } = require('express-validator');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { optionalAuth } = require('../middleware/auth');
const { fetchExternalRatings } = require('../services/externalRatings');
const { normalizeTitleForSearch, clusterBookSeries, pickSeriesRepresentative, sortByCastOrder } = require('../lib/mediaHelpers');

// Shared by the `tag` param (tags array only, AND-combined with other active
// filters — used by search.html's dedicated tag field), the genre/tag
// matching folded into the main search box's termClause below (tags OR
// genres — a user typing "LitRPG" shouldn't need to know whether that's
// stored as a tag or a genre), and `excludeFilter` (the negated version, for
// Browse's "Not" box). Case-insensitive matching against a free-text input
// requires generating the likely stored forms ourselves, since Prisma's
// array `has`/`hasSome` is exact-string, not case-insensitive.
const FILTER_TERM_OVERRIDES = {
  'hbo':'HBO','hbo max':'HBO Max','apple tv':'Apple TV','apple tv+':'Apple TV+',
  'nbc':'NBC','cbs':'CBS','abc':'ABC','amc':'AMC','fx':'FX','bbc':'BBC','pbs':'PBS',
  'mtv':'MTV','usa':'USA','tnt':'TNT','tbs':'TBS','syfy':'Syfy','espn':'ESPN',
  'nfl':'NFL','nba':'NBA','mlb':'MLB','nhl':'NHL','dc':'DC','mcu':'MCU','uk':'UK',
  'litrpg':'LitRPG',
};
function buildTagVariants(rawTerm) {
  const lower     = rawTerm.toLowerCase();
  const titleCase = rawTerm.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  const normalized = FILTER_TERM_OVERRIDES[lower]
    || rawTerm.split(' ').map(w => FILTER_TERM_OVERRIDES[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
  return [...new Set([rawTerm, lower, titleCase, normalized])];
}

// Builds a mediaItemId -> rating map for a user's own reviews, rolling TV
// seasons up to their parent show — reviews are written per season, but
// browse only ever displays the parent row, so a flat mediaItemId->rating
// map would never match a show the user rated only by season (confirmed
// live: a user's rated-but-season-only shows sorted as "unreviewed", and
// were excluded from their average). Matches the same "series rating if one
// exists, else average of seasons" convention used by taste-profile in
// src/routes/users.js.
async function buildUserRatingsMap(userId, whereExtra = {}, individualBookMode = false) {
  const reviews = await prisma.review.findMany({
    where: { userId, ...whereExtra },
    select: { mediaItemId: true, rating: true, seasonNumber: true },
  });
  // A book series representative can carry two separate reviews on the same
  // mediaItemId — an ordinary individual rating of that one book
  // (seasonNumber: null) and a genuine whole-series verdict (seasonNumber:
  // 0, see item.html's Rating Scope toggle). Which one should win depends
  // entirely on what the card being built actually represents: the
  // condensed/series card (individualBookMode: false, the default) stands
  // in for "the series as a whole", so the series verdict is the more
  // authoritative answer there. But Browse's "Show Individually" toggle
  // renders that exact same row as book 1 specifically, alongside book 2,
  // book 3, etc. — showing the series verdict there is simply wrong, not a
  // stand-in choice, since the card is explicitly "book 1", not "the
  // series". Confirmed live: He Who Fights With Monsters book 1 individually
  // rated 7, later given an overall series verdict of 5 — the individually-
  // shown book-1 card was showing 5 (the series review winning
  // unconditionally, regardless of which card was being built).
  const map = {};
  for (const r of reviews) {
    const prefersThis = individualBookMode ? r.seasonNumber !== 0 : r.seasonNumber === 0;
    if (map[r.mediaItemId] == null || prefersThis) map[r.mediaItemId] = r.rating;
  }

  const seasons = await prisma.mediaItem.findMany({
    where: { id: { in: reviews.map(r => r.mediaItemId) }, parentId: { not: null } },
    select: { id: true, parentId: true },
  });
  if (seasons.length) {
    const byParent = {};
    for (const s of seasons) (byParent[s.parentId] ||= []).push(map[s.id]);
    for (const [parentId, ratings] of Object.entries(byParent)) {
      if (map[parentId] != null) continue; // an explicit series-level review wins
      map[parentId] = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    }
  }

  // Book series: same "series rating if one exists, else average what I've
  // rated across the series" convention as TV above, but books have no
  // parent/child rows to roll up (see CLAUDE.md) — clusterBookSeries groups
  // by seriesName+shared-authorship instead. Mirrors the community-wide
  // aggregate's priority (directRatingMap > bookSeriesRatingMap) built
  // further down in the main /media handler, just scoped to this one user's
  // own reviews. Without this, "You: X/10" on a series card showed only
  // whatever this user rated the representative book itself, ignoring any
  // other books in the series they'd individually rated (confirmed live:
  // a series showed the user's 7/10 for book 1 even though they'd since
  // rated several later books much lower).
  //
  // Entirely skipped in individualBookMode: this whole block exists to
  // answer "what's my rating for the SERIES", which only makes sense for
  // the condensed/representative card. In individual mode the representative
  // is being shown as book 1 specifically, and every book (including book 1)
  // already got its own direct rating from the loop above — cross-book
  // averaging or letting a series-level review leak onto book 1's own card
  // would both be wrong there, not just a different way of answering the
  // same question.
  const seasonIds = new Set(seasons.map(s => s.id));
  const bookReviewIds = reviews.filter(r => !seasonIds.has(r.mediaItemId)).map(r => r.mediaItemId);
  if (bookReviewIds.length && !individualBookMode) {
    const reviewedBooks = await prisma.mediaItem.findMany({
      where: { id: { in: bookReviewIds }, mediaType: 'BOOK', seriesName: { not: null } },
      select: { seriesName: true },
    });
    const seriesNames = [...new Set(reviewedBooks.map(b => b.seriesName))];
    if (seriesNames.length) {
      const allSeriesBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: { in: seriesNames } },
        select: { id: true, seriesName: true, seriesNumber: true, authors: { select: { id: true } } },
      });
      const bookIdToRepId = {};
      for (const cluster of clusterBookSeries(allSeriesBooks)) {
        const rep = pickSeriesRepresentative(cluster.books);
        for (const b of cluster.books) bookIdToRepId[b.id] = rep.id;
      }
      const directByRep = {};
      const individualByRep = {};
      for (const r of reviews) {
        const repId = bookIdToRepId[r.mediaItemId];
        if (!repId) continue;
        if (r.seasonNumber === 0) directByRep[repId] = r.rating;
        else (individualByRep[repId] ||= []).push(r.rating);
      }
      for (const repId of new Set([...Object.keys(directByRep), ...Object.keys(individualByRep)])) {
        if (directByRep[repId] != null) { map[repId] = directByRep[repId]; continue; }
        const ratings = individualByRep[repId];
        if (ratings?.length) map[repId] = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      }
    }
  }

  return map;
}

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
  // Whether this request is Browse's "Show Individually" book view (each
  // book its own card, e.g. book 1 shown as book 1, not as the series
  // representative) — see buildUserRatingsMap's individualBookMode param.
  const individualBookMode = type === 'BOOK' && !!req.query.individual;
  const friendsOnly      = req.query.friendsOnly === 'true';
  // excludeFriends: comma-separated emails to exclude from friend ratings
  const excludeFriends   = req.query.excludeFriends
    ? req.query.excludeFriends.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  // consumedWithin: only count reviews where dateConsumed >= N months ago
  // Format: "12m" = 12 months, "2y" = 2 years
  const consumedWithin   = req.query.consumedWithin || null;
  // Computed once up top so both req.myRatings/req.reviewedByRatings below
  // (the logged-in user's own ratings, used by Share a Card's recency
  // filter among other things) and the aggregate/friend-rating queries
  // further down share the same cutoff instead of each parsing it separately.
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
  const consumedFilter = consumedCutoff ? { dateConsumed: { gte: consumedCutoff } } : {};
  // reviewedBy: a username — filter to only items reviewed by that specific user
  const reviewedBy = req.query.reviewedBy?.trim();
  // reviewStatus: 'unreviewed', 'reviewed', or 'all' — powers Browse's review-status
  // dropdown. Scoped to whichever person is relevant: the reviewedBy target if
  // Browse's "select a friend" dropdown picked one, otherwise the logged-in user
  // themself. Distinguished from "param absent" (null) so that reviewedBy alone
  // (search.html's older "Reviewed by" field, which has no separate status concept)
  // keeps its original meaning of "only their reviewed items" — see andClauses below.
  const reviewStatus = ['unreviewed', 'reviewed', 'all'].includes(req.query.reviewStatus)
    ? req.query.reviewStatus
    : null;
  // Whether Browse's controls actually narrow the catalog — the search box
  // (q), the Filter box's genre/tag/person chips, or the "Not" box — as
  // opposed to plain unfiltered browsing. Powers the "your average" summary
  // (searchAvgRating below). A person-only Filter selection (no text term at
  // all) still counts: e.g. picking just "Matt Damon" with nothing typed.
  const hasActiveFilter = !!(q && q.trim())
    || !!(req.query.filter && req.query.filter.trim())
    || !!(req.query.excludeFilter && req.query.excludeFilter.trim())
    || !!req.query.personId || !!req.query.excludePersonId;
  const take = 24;

  try {
    // reviewedBy filter — look up the user and get their reviewed item IDs
    let reviewedByIds = undefined;
    let reviewedByUserId = null;
    if (reviewedBy) {
      const reviewedByUser = await prisma.user.findFirst({
        where: {
          OR: [
            { username:    { equals: reviewedBy, mode: 'insensitive' } },
            { displayName: { contains: reviewedBy, mode: 'insensitive' } },
          ],
        },
        select: { id: true, profilePublic: true },
      });
      if (reviewedByUser) {
        // Same visibility rule as GET /api/users/:username and its
        // taste-profile counterpart — a private account is only viewable by
        // its own owner and accepted friends. This was previously missing
        // entirely here, so a shared browse-card link (or the "Reviewed by"
        // search field) could be used to enumerate a private account's
        // ratings by username alone, bypassing the same gate the profile
        // page already enforces. Confirmed live as a real gap, not just a
        // theoretical one.
        const isSelf = req.user?.id === reviewedByUser.id;
        let canView = reviewedByUser.profilePublic || isSelf;
        if (!canView && req.user) {
          const friendship = await prisma.friendship.findFirst({
            where: {
              status: 'ACCEPTED',
              OR: [
                { initiatorId: req.user.id, receiverId: reviewedByUser.id },
                { initiatorId: reviewedByUser.id, receiverId: req.user.id },
              ],
            },
          });
          if (friendship) canView = true;
        }
        if (!canView) {
          return res.json({ items: [], total: 0, page: parseInt(page), pages: 0, reviewedByPrivate: true });
        }
        reviewedByUserId = reviewedByUser.id;
        req.reviewedByRatings = await buildUserRatingsMap(reviewedByUser.id, { visibility: { in: ['PUBLIC', 'FRIENDS_ONLY'] }, ...consumedFilter }, individualBookMode);
        // reviewedByIds still drives the legacy "only their reviewed items"
        // filter below (search.html) — direct ids only, since andClauses
        // separately rolls seasons up to parentId for the reviewStatus path.
        reviewedByIds = Object.keys(req.reviewedByRatings);
      } else {
        // User not found — return empty results rather than ignoring the filter
        return res.json({ items: [], total: 0, page: parseInt(page), pages: 0, reviewedByNotFound: true });
      }
    }

    // The logged-in user's own ratings — used to show their rating alongside a
    // selected friend's for comparison (Browse's friend dropdown), and to
    // compute the "your average" summary Browse shows atop results, whether
    // that's an average across a filtered search or, with nothing filtered,
    // their overall average for the current media type (searchAvgRating
    // below). Cheap regardless — bounded by the user's own review count, not
    // catalog size. Not surfaced per-card outside the friend-comparison case.
    if (req.user && (!reviewedByUserId || req.user.id !== reviewedByUserId)) {
      req.myRatings = await buildUserRatingsMap(req.user.id, consumedFilter, individualBookMode);
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

    // Exact-person filter — Browse's smart search sends one or more specific
    // Person ids (picked from /api/media/search-suggestions) instead of name
    // strings, sidestepping the substring-match ambiguity `person` above has
    // (e.g. "Tom Holland" also matching "Tom Hollander").
    // Comma-separated for multiple people, AND-combined — the item must
    // feature every one of them (in any of the three role relations).
    let personIdFilter = undefined;
    if (req.query.personId) {
      const personIds = req.query.personId.split(',').map(s => s.trim()).filter(Boolean);
      const personIdClauses = personIds.map(id => ({
        OR: [
          { directors: { some: { id } } },
          { cast:      { some: { id } } },
          { authors:   { some: { id } } },
        ],
      }));
      personIdFilter = personIdClauses.length === 1 ? personIdClauses[0] : { AND: personIdClauses };
    }

    // Exact-person EXCLUDE filter — the negated counterpart of personId
    // above, for Browse's "Not" field (e.g. exclude a specific actor's
    // titles). Comma-separated, OR-combined for exclusion — matching ANY of
    // the excluded people is enough to drop an item.
    let excludePersonIdFilter = undefined;
    if (req.query.excludePersonId) {
      const excludeIds = req.query.excludePersonId.split(',').map(s => s.trim()).filter(Boolean);
      excludePersonIdFilter = { NOT: { OR: excludeIds.map(id => ({
        OR: [
          { directors: { some: { id } } },
          { cast:      { some: { id } } },
          { authors:   { some: { id } } },
        ],
      })) } };
    }

    // Genre search — check both genres array and title/description
    let genreFilter = undefined;
    if (genre && genre.trim().length > 0) {
      genreFilter = { genres: { has: genre.trim() } };
    }

    // Text search across title and series name — or, when qScope is
    // 'keyword' (search.html's older field only; Browse's plain search box
    // always sends 'title'), also person names. Deliberately excludes
    // description — a spam-stuffed description (e.g. a self-published book
    // listing dozens of unrelated famous titles/authors "fans of X will
    // enjoy this") could surface in a search for any of those names — and
    // genre/tag, which lives in the separate `filter`/`excludeFilter` params
    // instead (Browse's Filter/Not boxes): folding genre/tag into `q` here
    // meant simply picking a genre from Filter, with no text typed at all,
    // set q non-empty and forced the expensive full-catalog fetch path below
    // (fullFetchMode) even for the plain default "Highest Rated" sort —
    // reintroducing the exact 51-second regression fixed earlier in this
    // file's history, just via a different trigger.
    function termClause(term) {
      // Multi-word terms also match titles/series names where every word
      // appears somewhere, not just as one contiguous phrase — confirmed
      // live: searching "Mario Baseball" found nothing because the only
      // real match, "Mario Superstar Baseball", doesn't contain "mario
      // baseball" as a substring. relevance() below still ranks a
      // contiguous phrase match higher than this word-scatter fallback.
      const words = term.split(/\s+/).filter(Boolean);
      const wordFallbacks = words.length > 1 ? [
        { AND: words.map(w => ({ title:      { contains: w, mode: 'insensitive' } })) },
        { AND: words.map(w => ({ seriesName: { contains: w, mode: 'insensitive' } })) },
      ] : [];

      // Punctuation-insensitive title match — "la confidential" should also
      // find "L.A. Confidential". A plain `contains` against the raw title
      // can't do this (the term has no periods but the stored title does),
      // so this compares against the indexed, punctuation-stripped
      // normalizedTitle column instead, using the same stripping on the
      // term itself. Skipped when the normalized term is empty (e.g. a
      // term that's pure punctuation) since an empty `contains` matches everything.
      const normalizedTerm = normalizeTitleForSearch(term);
      const normalizedTitleMatch = normalizedTerm
        ? [{ normalizedTitle: { contains: normalizedTerm, mode: 'insensitive' } }]
        : [];

      return qScope === 'title' ? {
        OR: [
          { title:      { contains: term, mode: 'insensitive' } },
          { seriesName: { contains: term, mode: 'insensitive' } },
          ...normalizedTitleMatch,
          ...wordFallbacks,
        ],
      } : {
        OR: [
          { title:       { contains: term, mode: 'insensitive' } },
          { seriesName:  { contains: term, mode: 'insensitive' } },
          ...normalizedTitleMatch,
          // Also search via person names in the same term
          { directors: { some: { name: { contains: term, mode: 'insensitive' } } } },
          { cast:      { some: { name: { contains: term, mode: 'insensitive' } } } },
          { authors:   { some: { name: { contains: term, mode: 'insensitive' } } } },
          ...wordFallbacks,
        ],
      };
    }

    let textFilter = undefined;
    if (q && q.trim().length > 0) {
      const qTrimmed = q.trim();
      // Comma-separated terms are AND-combined (e.g. "Batman, DC" — title/
      // person/genre/tag match on "Batman" AND on "DC"), letting one box do
      // what used to need a separate title-search box plus a genre/tag box.
      // Also tries the whole trimmed string as a single phrase regardless —
      // 901 real titles contain a literal comma (e.g. "Monsters, Inc."), and
      // this keeps searching one of those verbatim from silently degrading
      // into an narrower/wrong AND-of-fragments match.
      const commaTerms = qTrimmed.split(',').map(t => t.trim()).filter(Boolean);
      const wholeMatch = termClause(qTrimmed);
      textFilter = commaTerms.length > 1
        ? { OR: [wholeMatch, { AND: commaTerms.map(termClause) }] }
        : wholeMatch;
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

      // Apply excluded friends — look up their user IDs by email. Email, not
      // username: excludedFriends stores email now that a username can be
      // changed by its owner (PATCH /api/users/me/settings) — a stored
      // username would silently stop matching on rename.
      if (excludeFriends.length) {
        const excluded = await prisma.user.findMany({
          where: { email: { in: excludeFriends } },
          select: { id: true },
        });
        const excludedIds = new Set(excluded.map(u => u.id));
        friendIds = friendIds.filter(id => !excludedIds.has(id));
      }
    }
    const friendFilter = friendsOnly && friendIds.length
      ? { userId: { in: friendIds } }
      : {};

    // Reviewed-item ids for whichever person reviewStatus is scoped to — the
    // reviewedBy target when Browse's "select a friend" dropdown picked one,
    // otherwise the logged-in user themself. Used by both directions of the
    // reviewStatus filter (exclude for 'unreviewed', include for 'reviewed').
    const statusTargetUserId = reviewedByUserId || req.user?.id || null;
    let reviewedIds = [];
    if ((reviewStatus === 'unreviewed' || reviewStatus === 'reviewed') && statusTargetUserId) {
      const reviewed = await prisma.review.findMany({
        where: { userId: statusTargetUserId },
        select: { mediaItemId: true },
      });
      const directIds = reviewed.map(r => r.mediaItemId);

      // For TV shows, reviews are written on seasons (children) — a parent
      // show is excluded from "Unreviewed only" as soon as ANY season has
      // been reviewed, not only once every season is done. Previously this
      // required ALL seasons reviewed, so a show the user had already
      // started reviewing kept reappearing under "Unreviewed only" for
      // every season still left — confirmed live as not matching what
      // "Unreviewed only" should mean.
      const reviewedSeasons = await prisma.mediaItem.findMany({
        where: { id: { in: directIds }, parentId: { not: null } },
        select: { parentId: true },
      });
      const reviewedParentIds = [...new Set(reviewedSeasons.map(s => s.parentId))];

      reviewedIds = [...new Set([...directIds, ...reviewedParentIds])];
    }

    // Build where clause using AND array to avoid OR key collisions when
    // multiple OR-based filters (textFilter, personFilter, book series) are combined.
    // verified:true always applies here — this is the public browse/search endpoint,
    // items awaiting admin review (scripts/bulk-import.js, admin bulk-import) are
    // reviewed via GET /api/admin/media/pending instead, not this route.
    const andClauses = [{ verified: true }];

    // 'SCREEN' is Browse's merged Movies & TV tab — not a real MediaType, just a
    // sentinel meaning "MOVIE or TV_SHOW, but not BOOK/VIDEO_GAME". includesTV
    // below lets the TV-specific structural filters (parent-only, person-search
    // season inclusion) apply equally in the combined view — they're harmless
    // no-ops against movie rows since parentId is always null on those anyway.
    const includesTV = type === 'TV_SHOW' || type === 'SCREEN';
    if (type === 'SCREEN')                andClauses.push({ mediaType: { in: ['MOVIE', 'TV_SHOW'] } });
    else if (type)                         andClauses.push({ mediaType: type });
    // TV filtering: normally show only parent shows (parentId: null).
    // BUT when searching by person/text (which can match an actor), also allow
    // seasons — a guest actor in one season should surface that specific season.
    // We dedupe below: if the parent show already matches, we drop its seasons.
    const tvPersonSearch = (personFilter || (textFilter && q)) && includesTV;
    // individual-seasons toggle is TV_SHOW-only (not exposed in the combined
    // SCREEN view — see browse.html), so it's deliberately excluded from this
    // condition for type==='SCREEN' — otherwise a stray ?individual=true would
    // skip the parent-only restriction and flood the combined view with every
    // season of every show, unfiltered.
    if (includesTV && !(type === 'TV_SHOW' && req.query.individual) && !tvPersonSearch) {
      andClauses.push({ parentId: null });
    }
    // Individual-seasons toggle is TV_SHOW-only (not exposed in the combined
    // SCREEN view — see browse.html) since {parentId:{not:null}} would also
    // wrongly exclude every movie row from a combined Movies+TV result set.
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
    // `decade`/`excludeDecade` — Browse's Decade picker, comma-separated
    // decade-start-years (e.g. "1980,2000" for the 1980s and 2000s). Each
    // decade OR's its own 10-year range, and multiple decades are
    // themselves OR'd together — separate from yearFrom/yearTo (a single
    // continuous range) since decades need to support disjoint selections,
    // e.g. 1980s + 2000s without also matching the 1990s.
    if (req.query.decade) {
      const decades = req.query.decade.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
      if (decades.length) {
        andClauses.push({ OR: decades.map(d => ({ releaseYear: { gte: d, lte: d + 9 } })) });
      }
    }
    if (req.query.excludeDecade) {
      const decades = req.query.excludeDecade.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
      if (decades.length) {
        // Same NULL-handling gotcha as the tags/genres exclude below: an
        // item with no releaseYear at all should pass an exclude filter
        // (it's not IN the excluded decade), but `NOT (NULL BETWEEN...)`
        // evaluates to NULL under Postgres's three-valued logic, which a
        // WHERE clause treats as "drop this row" — the explicit
        // releaseYear:null branch is what actually keeps it.
        andClauses.push({ OR: [
          { releaseYear: null },
          { NOT: { OR: decades.map(d => ({ releaseYear: { gte: d, lte: d + 9 } })) } },
        ]});
      }
    }
    // `platform`/`excludePlatform` — Browse's Filter/Not boxes, comma-
    // separated streaming provider names (e.g. "Netflix,Max"). Only ever
    // populated on movies and TV parent rows (scripts/sync-streaming-
    // providers.js is show-level, not per-season), and only ever checks
    // flatrate (subscription-included) availability, not rent/buy — "on
    // Netflix" means it's included with the subscription, not that it's
    // rentable there. streamingProviders is a JSON column, so matching an
    // element inside its flatrate array isn't expressible through Prisma's
    // query builder — resolved via a raw query to the matching ids first,
    // same two-step pattern as everywhere else in this file that needs SQL
    // Prisma can't generate (see buildTagVariants usage / search-suggestions).
    async function idsWithPlatform(names) {
      if (!names.length) return [];
      const rows = await prisma.$queryRaw`
        SELECT DISTINCT "MediaItem".id
        FROM "MediaItem", jsonb_array_elements(COALESCE("streamingProviders"->'flatrate', '[]'::jsonb)) AS p
        WHERE p->>'name' ILIKE ANY(${names.map(n => `%${n}%`)})
      `;
      return rows.map(r => r.id);
    }
    if (req.query.platform) {
      const names = req.query.platform.split(',').map(t => t.trim()).filter(Boolean);
      const ids = await idsWithPlatform(names);
      andClauses.push({ id: { in: ids } });
    }
    if (req.query.excludePlatform) {
      const names = req.query.excludePlatform.split(',').map(t => t.trim()).filter(Boolean);
      const ids = await idsWithPlatform(names);
      andClauses.push({ id: { notIn: ids } });
    }
    if (genreFilter)    andClauses.push(genreFilter);
    let tagVariants = [];
    if (req.query.tag) {
      tagVariants = buildTagVariants(req.query.tag.trim());
      andClauses.push({ tags: { hasSome: tagVariants } });
    }
    // `filter` — Browse's Filter box, genre/tag chips (kind !== 'person';
    // person chips instead go through personIdFilter above). Comma-separated,
    // AND-combined per term — an item must match every filter selected (e.g.
    // genre "Action" AND tag "MCU"). Deliberately its own param rather than
    // folded into q/textFilter: doing that previously meant just picking a
    // genre from Filter, with nothing typed in the plain search box, still
    // set q non-empty and forced textActive/fullFetchMode below, bypassing
    // the fast canOptimizeRatingSort path even for a plain "Highest Rated"
    // browse — the exact regression this param exists to avoid.
    // Genre/tag only — no title/seriesName contains. The box is labeled
    // "Filter: genre, tag, actor, director…", not a text search, and a
    // title-contains match let picking the "Marvel" tag also pull in
    // unrelated titles that merely contain the word (The Marvelous Mrs.
    // Maisel, Underground Marvels) — confirmed live.
    if (req.query.filter) {
      const filterTerms = req.query.filter.split(',').map(t => t.trim()).filter(Boolean);
      andClauses.push(...filterTerms.map(t => ({
        OR: [
          { tags:   { hasSome: buildTagVariants(t) } },
          { genres: { hasSome: buildTagVariants(t) } },
        ],
      })));
    }
    // `excludeFilter` — Browse's "Not" box, the negated counterpart of
    // `filter` above: genre/tag only, same reasoning (not title/seriesName —
    // see the comment on `filter`). Person names go through
    // excludePersonIdFilter below instead. Comma-separated so multiple terms
    // can each be excluded (OR semantics — excluding EITHER DC or Marvel, not
    // requiring both to be present on the same item).
    let excludeFilterVariants = [];
    if (req.query.excludeFilter) {
      const excludeTerms = req.query.excludeFilter.split(',').map(t => t.trim()).filter(Boolean);
      excludeFilterVariants = excludeTerms.flatMap(t => buildTagVariants(t));
      // Each negated condition below is AND-combined (De Morgan's — excluding
      // if ANY term matches means keeping only rows that match NONE) and
      // explicitly OR'd with an is-null check, since tags/genres are
      // nullable columns. Confirmed live: `tags` is actually NULL (not just
      // an empty array) on ~97% of TV_SHOW rows, and Postgres's three-valued
      // logic means `NOT (NULL somearray && ARRAY[...])` evaluates to NULL,
      // not TRUE — so a plain `NOT: { OR: [...] }` here silently dropped
      // nearly every row regardless of what was being excluded
      // (excludeFilter=Animation on Browse's TV tab returned zero results
      // for shows that clearly aren't animated).
      andClauses.push(
        { OR: [{ tags: { equals: null } }, { NOT: { tags: { hasSome: excludeFilterVariants } } }] },
        { OR: [{ genres: { equals: null } }, { NOT: { genres: { hasSome: excludeFilterVariants } } }] },
      );
    }
    if (excludePersonIdFilter) andClauses.push(excludePersonIdFilter);
    // NOTE: seriesName-only, no author scoping — same collision class as
    // clusterBookSeries above. Confirmed this param isn't exercised by any
    // live frontend navigation today (browse.html/search.html never link
    // with ?series=, and item.html's own series back-link uses the
    // author-safe seriesRepSlug instead), so left as-is rather than guessing
    // at what a direct API caller would want disambiguated by.
    if (req.query.series)   andClauses.push({ seriesName: req.query.series });
    if (textFilter)         andClauses.push(textFilter);
    if (personFilter)       andClauses.push(personFilter);
    if (personIdFilter)     andClauses.push(personIdFilter);
    if (reviewStatus === 'unreviewed' && reviewedIds.length) andClauses.push({ id: { notIn: reviewedIds } });
    if (reviewStatus === 'reviewed') andClauses.push({ id: { in: reviewedIds.length ? reviewedIds : ['__none__'] } });
    // reviewedBy with no reviewStatus at all (search.html's older "Reviewed by" field,
    // which has no status concept of its own) keeps its original meaning: restrict to
    // only their reviewed items. When reviewStatus IS present (Browse's friend dropdown
    // always sends one explicitly — see browse.html), it already did the equivalent
    // restriction above scoped via statusTargetUserId, or 'all' deliberately means no
    // restriction — so reviewedBy becomes pure rating-comparison enrichment instead.
    if (reviewedByIds !== undefined && reviewStatus === null) andClauses.push({ id: { in: reviewedByIds.length ? reviewedByIds : ['__none__'] } });
    if (!type) andClauses.push({ NOT: { AND: [{ mediaType: 'TV_SHOW' }, { parentId: null }] } });

    const where = andClauses.length > 0 ? { AND: andClauses } : {};

    // For 'rating' sort we can't use Prisma orderBy because avgRating is computed
    // post-fetch. Use createdAt as a stable DB sort, then re-sort by avgRating in JS.
    // 'popular' sorts by review count which Prisma can do directly.
    const orderBy = {
      popular: [{ reviews: { _count: 'desc' } }],
      recent:  [{ createdAt: 'desc' }],
      title:   [{ title: 'asc' }],
      // Explicit nulls:'last' on both — DESC defaults to nulls-first in SQL,
      // which would otherwise surface every year-less item before 2026's.
      year:    [{ releaseYear: { sort: 'asc',  nulls: 'last' } }],
      yearDesc:[{ releaseYear: { sort: 'desc', nulls: 'last' } }],
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
      if (genreFilter)     seriesWhereClauses.push(genreFilter);
      if (textFilter)      seriesWhereClauses.push(textFilter);
      if (personFilter)    seriesWhereClauses.push(personFilter);
      if (personIdFilter)  seriesWhereClauses.push(personIdFilter);
      if (excludePersonIdFilter) seriesWhereClauses.push(excludePersonIdFilter);
      if (req.query.tag)    seriesWhereClauses.push({ tags: { hasSome: tagVariants } });
      if (req.query.filter) {
        const filterTerms = req.query.filter.split(',').map(t => t.trim()).filter(Boolean);
        seriesWhereClauses.push(...filterTerms.map(t => ({
          OR: [
            { tags:   { hasSome: buildTagVariants(t) } },
            { genres: { hasSome: buildTagVariants(t) } },
          ],
        })));
      }
      if (req.query.excludeFilter) {
        // Null-safe De Morgan's expansion — see the main excludeFilter block
        // above for why a plain NOT: { OR: [...] } silently drops rows with
        // a null tags/genres column instead of matching them.
        seriesWhereClauses.push(
          { OR: [{ tags: { equals: null } }, { NOT: { tags: { hasSome: excludeFilterVariants } } }] },
          { OR: [{ genres: { equals: null } }, { NOT: { genres: { hasSome: excludeFilterVariants } } }] },
        );
      }

      allSeriesEntries = await prisma.mediaItem.findMany({
        where: { AND: seriesWhereClauses },
        include: {
          _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
          authors: { select: { id: true, name: true, slug: true }, take: 100 },
          parent:  { select: { id: true, title: true, slug: true } },
        },
      });
        // Deduplicate to lowest seriesNumber per series cluster — same
      // seriesName is necessary but not sufficient (see clusterBookSeries).
      // BUT: if a text search returns multiple books from the same series,
      // show them individually rather than collapsing to the representative.
      const clusters = clusterBookSeries(allSeriesEntries);
      seriesCountMap = new Map();
      for (const cluster of clusters) {
        seriesCountMap.set(cluster.books[0].seriesName, (seriesCountMap.get(cluster.books[0].seriesName) || 0) + cluster.books.length);
      }
      seriesRepresentatives = clusters.map(cluster => pickSeriesRepresentative(cluster.books));
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

    // Plain rating-sort browsing with no text search and no book-series
    // collapsing (i.e. Browse's default view for Movies/TV/Games, and Books
    // when a series filter narrows things down) is the case that broke at
    // catalog scale: fetching every matching row with full nested includes
    // (directors/cast/authors/parent, each up to 100) just to sort by rating
    // and discard all but ~24 of them took 51+ seconds against 17k+ movies.
    // Confirmed live: browsing Movies with an empty search box "stalled" for
    // exactly this reason. Fix: get just the ids + ratings cheaply (no
    // joins), sort/paginate THAT, then do the expensive full fetch only for
    // the one page of ids actually needed. textActive/collapseBookSeries
    // still use the old full-fetch path since relevance ranking and series
    // clustering both genuinely need the whole matching set in hand.
    const canOptimizeRatingSort = ratingSort && !textActive && !collapseBookSeries;

    let items, total;
    if (canOptimizeRatingSort) {
      const idRows = await prisma.mediaItem.findMany({ where, select: { id: true, mediaType: true, tmdbRating: true, openCriticScore: true } });
      const idList = idRows.map(r => r.id);
      total = idList.length;
      // External rating per item, normalized to a 0-10 scale — used below as
      // a tiebreak when two items have the same community rating on this
      // site (most commonly: both have zero reviews here yet, which is most
      // of the catalog). openCriticScore is IGDB's 0-100 game rating
      // (repurposed field, see schema comment); tmdbRating is already 0-10.
      // No book fallback yet — this app doesn't store an external per-book
      // rating (Google Books' averageRating/Open Library's ratings.json are
      // the closest analogs, but neither is fetched/persisted currently).
      const externalRatingMap = Object.fromEntries(idRows.map(r => [
        r.id,
        r.mediaType === 'VIDEO_GAME' ? (r.openCriticScore != null ? r.openCriticScore / 10 : null) : r.tmdbRating,
      ]));
      // Raw SQL with `= ANY($1::text[])` instead of Prisma's `{ in: idList }`
      // — an unfiltered whole-catalog browse (e.g. Browse All, Highest
      // Rated, no search/filter) puts ~49k ids in idList, and Prisma's `in`
      // sends one bind variable per id, blowing past Postgres's 32,767
      // prepared-statement limit ("too many bind variables", confirmed live
      // via GET /api/media?sort=rating with no other params). Passing the
      // array itself as a single bind parameter has no such limit regardless
      // of catalog size.
      const idRatings = idList.length === 0 ? [] : (friendsOnly && friendIds.length
        ? await prisma.$queryRaw`SELECT "mediaItemId", AVG(rating)::float AS avg FROM "Review" WHERE "mediaItemId" = ANY(${idList}) AND visibility = 'PUBLIC' AND "userId" = ANY(${friendIds}) GROUP BY "mediaItemId"`
        : await prisma.$queryRaw`SELECT "mediaItemId", AVG(rating)::float AS avg FROM "Review" WHERE "mediaItemId" = ANY(${idList}) AND visibility = 'PUBLIC' GROUP BY "mediaItemId"`);
      const idRatingMap = Object.fromEntries(idRatings.map(r => [r.mediaItemId, r.avg]));

      // TV reviews are always written per-season (see the data-model note in
      // CLAUDE.md), never against the parent show's own id — so the direct
      // lookup above finds virtually nothing for TV_SHOW rows, and "Highest
      // Rated" degenerated into arbitrary DB order for them (confirmed live:
      // browsing TV with a Marvel filter showed 4.0/7.0/8.0/9.0/5.0 in that
      // exact non-sorted order). Roll child-season ratings up to the parent
      // here, mirroring the same aggregation the display path below already
      // does for the current page's cards — this just needs to happen before
      // sorting too, not only after.
      const tvParentIds = idRows.filter(r => r.mediaType === 'TV_SHOW').map(r => r.id);
      if (tvParentIds.length) {
        const seasons = await prisma.mediaItem.findMany({
          where: { parentId: { in: tvParentIds } },
          select: { id: true, parentId: true },
        });
        const seasonIds = seasons.map(s => s.id);
        const seasonToParent = Object.fromEntries(seasons.map(s => [s.id, s.parentId]));
        if (seasonIds.length) {
          const seasonRatings = friendsOnly && friendIds.length
            ? await prisma.$queryRaw`SELECT "mediaItemId", AVG(rating)::float AS avg, COUNT(rating)::int AS cnt FROM "Review" WHERE "mediaItemId" = ANY(${seasonIds}) AND visibility = 'PUBLIC' AND "userId" = ANY(${friendIds}) GROUP BY "mediaItemId"`
            : await prisma.$queryRaw`SELECT "mediaItemId", AVG(rating)::float AS avg, COUNT(rating)::int AS cnt FROM "Review" WHERE "mediaItemId" = ANY(${seasonIds}) AND visibility = 'PUBLIC' GROUP BY "mediaItemId"`;
          const parentAccum = {};
          for (const r of seasonRatings) {
            const parentId = seasonToParent[r.mediaItemId];
            if (!parentId) continue;
            (parentAccum[parentId] ||= { sum: 0, count: 0 });
            parentAccum[parentId].sum   += r.avg * r.cnt;
            parentAccum[parentId].count += r.cnt;
          }
          for (const [parentId, acc] of Object.entries(parentAccum)) {
            if (acc.count > 0) idRatingMap[parentId] = acc.sum / acc.count;
          }
        }
      }
      idList.sort((a, b) => {
        // Items the logged-in user has already reviewed float to the top of a
        // filtered search (see hasActiveFilter/req.myRatings above) — ahead of
        // rating order, not just as a tiebreak within it.
        if (req.myRatings) {
          const aReviewed = req.myRatings[a] != null, bReviewed = req.myRatings[b] != null;
          if (aReviewed !== bReviewed) return aReviewed ? -1 : 1;
        }
        const ra = idRatingMap[a] ?? null, rb = idRatingMap[b] ?? null;
        if (ra !== rb) {
          if (ra === null) return 1; // unrated always last, regardless of direction
          if (rb === null) return -1;
          return sort === 'lowest' ? ra - rb : rb - ra;
        }
        // Equal community rating on this site (including the common case of
        // both having zero reviews here) — fall back to the external rating
        // instead of leaving the tie in arbitrary DB order.
        const ea = externalRatingMap[a] ?? null, eb = externalRatingMap[b] ?? null;
        if (ea === null && eb === null) return 0;
        if (ea === null) return 1;
        if (eb === null) return -1;
        return sort === 'lowest' ? ea - eb : eb - ea;
      });
      const pageNum = parseInt(page) - 1;
      const pageIds = idList.slice(pageNum * take, (pageNum + 1) * take);
      const pageItemsUnordered = await prisma.mediaItem.findMany({
        where: { id: { in: pageIds } },
        include: {
          _count: { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
          directors: { select: { id: true, name: true, slug: true }, take: 100 },
          authors:   { select: { id: true, name: true, slug: true }, take: 100 },
          cast:      { select: { id: true, name: true, slug: true }, take: 100 },
          parent:    { select: { id: true, title: true, slug: true } },
        },
      });
      // Prisma doesn't preserve `id: { in: [...] }` order — restore the rating-sorted order.
      const byId = Object.fromEntries(pageItemsUnordered.map(i => [i.id, i]));
      items = pageIds.map(id => byId[id]).filter(Boolean);
    } else {
      [items, total] = await Promise.all([
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
    }
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

    // seasonNumber: 0 is the book-series sentinel (a review of the SERIES,
    // not of the individual book whose row hosts the series page) — excluded
    // here so a book's own individual rating never gets blended with a
    // series-level review that happens to share the same mediaItemId.
    const ratings = await prisma.review.groupBy({
      by: ['mediaItemId'],
      where: { mediaItemId: { in: itemIds }, OR: [{ seasonNumber: null }, { seasonNumber: { not: 0 } }], visibility: 'PUBLIC', ...friendFilter },
      _avg: { rating: true },
      _count: { rating: true },
    });
    const ratingMap = Object.fromEntries(ratings.map(r => [r.mediaItemId, { avg: r._avg.rating, count: r._count.rating }]));

    // Direct/series-level reviews for book series cards — the counterpart of
    // the above: ONLY seasonNumber:0 reviews, i.e. reviews actually written
    // about the series as a whole. Confirmed live: Browse was showing "2
    // reviews" on a series card that had exactly one genuine series review,
    // because it was also counting the representative book's own individual
    // review (previously the two were never distinguished here).
    const directSeriesRatings = await prisma.review.groupBy({
      by: ['mediaItemId'],
      where: { mediaItemId: { in: itemIds }, seasonNumber: 0, visibility: 'PUBLIC', ...friendFilter },
      _avg: { rating: true },
      _count: { rating: true },
    });
    const directRatingMap = Object.fromEntries(directSeriesRatings.map(r => [r.mediaItemId, { avg: r._avg.rating, count: r._count.rating }]));

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

    // For book series: count books in each series and aggregate ratings.
    // Keyed by the representative's own id, not the raw seriesName string —
    // two unrelated authors can share an identical seriesName (see
    // clusterBookSeries), so the string alone can't safely key these maps.
    const bookSeriesCountMap = {};
    let bookCompletionMap = {};
    const bookSeriesRatingMap = {};
    if (bookSeriesNames.length && !reviewedBy) {
      const allSeriesBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: { in: bookSeriesNames } },
        select: { id: true, seriesName: true, seriesNumber: true, authors: { select: { id: true } } },
      });
      // Assign each fetched book to the specific series representative it
      // actually belongs to — same seriesName is necessary but not
      // sufficient, a book only belongs to a representative's series when it
      // shares at least one author with that representative.
      const repsByName = new Map();
      for (const rep of seriesRepresentatives) {
        const arr = repsByName.get(rep.seriesName) || [];
        arr.push(rep);
        repsByName.set(rep.seriesName, arr);
      }
      const bookIdToRepId = {};
      for (const b of allSeriesBooks) {
        if (!b.seriesName) continue;
        const bAuthorIds = new Set((b.authors || []).map(a => a.id));
        const candidates = repsByName.get(b.seriesName) || [];
        const rep = candidates.find(r => (r.authors || []).some(a => bAuthorIds.has(a.id))) || candidates[0];
        if (rep) bookIdToRepId[b.id] = rep.id;
      }
      // Count books per series
      for (const b of allSeriesBooks) {
        const repId = bookIdToRepId[b.id];
        if (!repId) continue;
        bookSeriesCountMap[repId] = (bookSeriesCountMap[repId] || 0) + 1;
      }
      // Aggregate ratings for all books in each series
      const allBookIds = allSeriesBooks.map(b => b.id);
      if (allBookIds.length) {
        const bookRatings = await prisma.review.groupBy({
          by: ['mediaItemId'],
          // Exclude seasonNumber:0 (series-level reviews) — "Avg book" should
          // only ever average actual per-book ratings, never a review of the
          // series as a whole that happens to share the representative's id.
          where: { mediaItemId: { in: allBookIds }, OR: [{ seasonNumber: null }, { seasonNumber: { not: 0 } }], visibility: 'PUBLIC', ...friendFilter, ...consumedFilter },
          _avg: { rating: true },
          _count: { rating: true },
        });
        const seriesAccum = {};
        for (const r of bookRatings) {
          const repId = bookIdToRepId[r.mediaItemId];
          if (!repId) continue;
          if (!seriesAccum[repId]) seriesAccum[repId] = { sum: 0, count: 0 };
          seriesAccum[repId].sum   += (r._avg.rating || 0) * r._count.rating;
          seriesAccum[repId].count += r._count.rating;
        }
        for (const [repId, acc] of Object.entries(seriesAccum)) {
          if (acc.count > 0) bookSeriesRatingMap[repId] = { avg: acc.sum / acc.count, count: acc.count };
        }

        // Average completion: avg number of books reviewed per user (who reviewed at least one)
        bookCompletionMap = {}; // reset before populating
        const allBookReviews = await prisma.review.findMany({
          where: {
            mediaItemId: { in: allBookIds },
            OR: [{ seasonNumber: null }, { seasonNumber: { not: 0 } }], // exclude series-level reviews, same reasoning as bookRatings above
            visibility: 'PUBLIC',
            ...friendFilter,
          },
          select: { userId: true, mediaItemId: true },
        });
        const byRepByUser = {};
        for (const r of allBookReviews) {
          const repId = bookIdToRepId[r.mediaItemId];
          if (!repId) continue;
          if (!byRepByUser[repId]) byRepByUser[repId] = {};
          if (!byRepByUser[repId][r.userId]) byRepByUser[repId][r.userId] = new Set();
          byRepByUser[repId][r.userId].add(r.mediaItemId);
        }
        for (const [repId, userMap] of Object.entries(byRepByUser)) {
          const userCounts = Object.values(userMap).map(s => s.size);
          const avgCompletion = userCounts.reduce((a, b) => a + b, 0) / userCounts.length;
          bookCompletionMap[repId] = {
            avg: Math.round(avgCompletion * 10) / 10,
            total: bookSeriesCountMap[repId] || 0,
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
      // Priority mirrors what the card actually displays as its primary
      // number: a genuine series-level review (directRatingMap) outranks the
      // "Avg book" aggregate (bookSeriesRatingMap), which outranks the
      // representative's own individual rating. Previously this checked
      // bookSeriesRatingMap first, so a series with a real 9.0 series review
      // but a 6.7 average across its books sorted by the 6.7 — Cradle's card
      // showed "9.0" but ranked as if it were a 6.7 under Top Rated.
      return (i.mediaType === 'BOOK' && i.seriesName && !req.query.series && !req.query.individual && isRep)
        ? (directRatingMap[i.id]?.avg || bookSeriesRatingMap[i.id]?.avg || ratingMap[i.id]?.avg || null)
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
    // Words of the query, used to rank the word-scatter fallback (see
    // wordFallbacks above) below a real contiguous-phrase match.
    const qWords = textActive ? qLower.split(/\s+/).filter(Boolean) : [];
    function relevance(i) {
      if (!textActive) return 0;
      const candidates = [i.title, i.seriesName].filter(Boolean).map(s => s.toLowerCase());
      let titleTier = 0;
      for (const c of candidates) {
        if (c === qLower)              titleTier = Math.max(titleTier, 5);
        else if (c.startsWith(qLower)) titleTier = Math.max(titleTier, 3);
        else if (c.includes(qLower))   titleTier = Math.max(titleTier, 2);
        // All query words present, just not as one contiguous phrase (e.g.
        // "Mario Baseball" against "Mario Superstar Baseball") — a real
        // title match, but weaker than an actual phrase-contains hit.
        else if (qWords.length > 1 && qWords.every(w => c.includes(w))) titleTier = Math.max(titleTier, 1.5);
      }
      // Only a genuine exact title/series match is unambiguous enough to
      // always win outright, before ever checking people. A prefix match
      // ("Kingdoms and Chaos" starting with "king") is NOT that unambiguous —
      // confirmed live: searching "King" was ranking "Kingdoms and Chaos",
      // "Kingsblood Royal", etc. above Stephen King's own books, since those
      // titles' startsWith match used to short-circuit before any author
      // check ran at all.
      if (titleTier >= 5) return titleTier;

      // A complete first/last name match now outranks BOTH a title-starts-
      // with match and a plain title-contains match — confirmed live for
      // both "Card" (Orson Scott Card over "The Cardturner"/"The Library
      // Card") and "King" (Stephen King over every "Kingdoms of X"/"King of
      // X" title). A partial/substring name match (tier 1) still ranks below
      // either kind of real title match.
      const people = [...(i.authors || []), ...(i.directors || []), ...(i.cast || [])];
      let personTier = 0;
      for (const p of people) {
        if (!p.name) continue;
        const nameLower = p.name.toLowerCase();
        if (qWordRe.test(nameLower))        personTier = Math.max(personTier, 4);
        else if (nameLower.includes(qLower)) personTier = Math.max(personTier, 1);
      }
      return Math.max(titleTier, personTier);
    }

    // Secondary ordering key — whatever the user's chosen sort represents —
    // used only to break ties within the same relevance tier.
    function secondaryKey(i) {
      switch (sort) {
        case 'rating': case 'lowest': return effectiveRating(i);
        case 'popular': return i._count?.reviews ?? 0;
        case 'year': case 'yearDesc': return i.releaseYear ?? null;
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

    // Items the logged-in user has already reviewed float to the top of a
    // filtered search (see hasActiveFilter/req.myRatings above) — ahead of
    // even relevance/rating order, not just as a tiebreak within it.
    function reviewedBoost(a, b) {
      if (!req.myRatings) return 0;
      const aReviewed = req.myRatings[a.id] != null, bReviewed = req.myRatings[b.id] != null;
      if (aReviewed === bReviewed) return 0;
      return aReviewed ? -1 : 1;
    }

    // Sort ALL matching items together (series + standalones) then paginate in JS —
    // required whenever avgRating drives the order (computed post-fetch) or a text
    // query is active (relevance can't be expressed as a DB-level orderBy).
    let sortedItems = finalItems;
    if (textActive) {
      sortedItems = [...finalItems].sort((a, b) => {
        const relA = relevance(a), relB = relevance(b);
        // A perfect title match (tier 5, set only for an exact, full title/
        // series-name match — see relevance() above) wins outright, ahead of
        // even reviewedBoost — otherwise searching the exact title of an
        // unreviewed item got buried under items the user happened to have
        // reviewed themselves that only matched via a supporting cast
        // member's surname (e.g. searching "Little" for the movie "Little"
        // lost to an already-reviewed unrelated movie whose cast included
        // someone named "Little"). Multiple perfect matches (relA === relB)
        // still fall through to reviewedBoost/compareSecondary below.
        if ((relA >= 5 || relB >= 5) && relA !== relB) return relB - relA;
        const boost = reviewedBoost(a, b);
        if (boost !== 0) return boost;
        return relA !== relB ? relB - relA : compareSecondary(a, b);
      });
      const pageNum = parseInt(page) - 1;
      sortedItems = sortedItems.slice(pageNum * take, (pageNum + 1) * take);
    } else if ((sort === 'rating' || sort === 'lowest') && !canOptimizeRatingSort) {
      sortedItems = [...finalItems].sort((a, b) => {
        const boost = reviewedBoost(a, b);
        return boost !== 0 ? boost : compareSecondary(a, b);
      });
      // Re-apply pagination after sorting
      const pageNum = parseInt(page) - 1;
      sortedItems = sortedItems.slice(pageNum * take, (pageNum + 1) * take);
    }
    // When canOptimizeRatingSort was used, finalItems (== items) already came
    // back pre-sorted and pre-paginated to exactly this page — re-slicing it
    // here with the current pageNum would double-paginate and return the
    // wrong (often empty) results for any page past the first.

    // "Your average" (or a selected friend's average) across every item
    // actually matching this filtered search — not just the current page —
    // shown atop Browse's results. Uses a dedicated id-only query against the
    // same `where` rather than finalItems/items, since which of those holds
    // the FULL matching set (vs. just the current page) varies by which fetch
    // path was taken above (canOptimizeRatingSort vs. full-fetch vs. plain
    // paginated) — a plain id lookup is correct and cheap regardless of path.
    // With nothing filtered, "your average" instead means your overall average
    // for the current media type — Movies, TV, Movies & TV combined, Books, or
    // Video Games, each tracked separately (no type at all, i.e. the untyped
    // Browse-All page, has no single type to average, so this stays null there).
    // Restricted to parentId:null rows so a TV show's rolled-up parent entry
    // (see buildUserRatingsMap) is counted once, never double-counted against
    // its own raw season entries also present in the same ratings map.
    let searchAvgRating = null;
    const ratingsMap = req.reviewedByRatings || req.myRatings;
    if (ratingsMap && Object.keys(ratingsMap).length) {
      if (hasActiveFilter) {
        const matchingIdRows = await prisma.mediaItem.findMany({ where, select: { id: true } });
        const matched = matchingIdRows.map(r => ratingsMap[r.id]).filter(r => r != null);
        if (matched.length) searchAvgRating = matched.reduce((a, b) => a + b, 0) / matched.length;
      } else {
        const typeScope = type === 'SCREEN' ? ['MOVIE', 'TV_SHOW'] : type ? [type] : null;
        if (typeScope) {
          const scopedIdRows = await prisma.mediaItem.findMany({
            where: { id: { in: Object.keys(ratingsMap) }, mediaType: { in: typeScope }, parentId: null },
            select: { id: true },
          });
          const matched = scopedIdRows.map(r => ratingsMap[r.id]).filter(r => r != null);
          if (matched.length) searchAvgRating = matched.reduce((a, b) => a + b, 0) / matched.length;
        }
      }
    }

    res.json({
      items: sortedItems.map(i => {
        // For series representative cards, use aggregated series ratings
        // A book is a series card if it's the series representative (lowest seriesNumber in series)
        // When text search active, series cards use individual book rating, not series aggregate
        const isSeriesRep = seriesRepresentatives.some(r => r.id === i.id);
        const isSeriesCard = i.mediaType === 'BOOK' && i.seriesName && !req.query.series && !req.query.individual && isSeriesRep;
        const isTvParentCard = i.mediaType === 'TV_SHOW' && !i.parentId;

        // avgRating: for book series cards, the same 3-tier priority
        // effectiveRating() above already documents and uses for sorting —
        // a genuine series-level review (directRatingMap) outranks the
        // cross-book average (bookSeriesRatingMap), which outranks the
        // representative's own individual rating (ratingMap) — but this
        // display value wasn't actually using that fallback chain, so a
        // series with no direct series-level review showed "No reviews
        // yet" (or the representative's lone individual rating) instead of
        // the real average across whatever books in the series had been
        // rated. Confirmed live: a series with only individually-rated
        // books showed nothing here despite "Avg book" having a real
        // number right next to it.
        // For TV parent cards: direct reviews of the show parent item
        // For individual items: their own reviews
        const avg   = isSeriesCard ? (directRatingMap[i.id]?.avg   ?? bookSeriesRatingMap[i.id]?.avg   ?? ratingMap[i.id]?.avg   ?? null) : ratingMap[i.id]?.avg;
        const count = isSeriesCard ? (directRatingMap[i.id]?.count ?? bookSeriesRatingMap[i.id]?.count ?? ratingMap[i.id]?.count ?? 0)    : ratingMap[i.id]?.count;

        // seriesAvgRating: aggregate of all books/seasons (only for series cards)
        const seriesAvgRating = isSeriesCard
          ? (bookSeriesRatingMap[i.id]?.avg || null)
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
            ? (bookSeriesCountMap[i.id] || 0)
            : undefined,
        avgCompletion: i.mediaType === 'TV_SHOW' && !i.parentId
          ? (tvCompletionMap?.[i.id] || null)
          : isSeriesCard
            ? (bookCompletionMap?.[i.id] || null)
            : undefined,
        reviewedByRating: req.reviewedByRatings?.[i.id] || null,
        myRating: req.myRatings?.[i.id] || null,
        }; // close the return object for isSeriesCard
      }),
      // For rating sort, total reflects the full sorted set (including series reps for books).
      // canOptimizeRatingSort already computed the true total itself (finalItems there is only
      // ever the current page), so it must NOT be overridden by finalItems.length like the
      // legacy full-fetch path below still correctly does for text search / book-series collapsing.
      total: canOptimizeRatingSort ? total : fullFetchMode ? finalItems.length : total,
      page: parseInt(page),
      pages: canOptimizeRatingSort ? Math.ceil(total / take) : fullFetchMode ? Math.ceil(finalItems.length / take) : Math.ceil(total / take),
      friendsOnly: friendsOnly && friendIds.length > 0,
      searchAvgRating,
      searchAvgIsFriend: !!req.reviewedByRatings,
    });
  } catch (err) { next(err); }
});

// ─── GET /api/media/search-suggestions ─────────────────────────────────────
// Unified autocomplete for Browse's search and "Not" boxes — combines
// matching titles, genres, tags, and people into one list so each kind of
// term the boxes search (title, genre, tag, actor/director/author) can be
// picked as an exact suggestion rather than typed as free text. Each
// suggestion carries a `kind` so the frontend knows how to file it: genre/tag
// become an exact text term (still matched via hasSome server-side, but
// against a known-real value instead of a guess); person carries an id
// instead, matched exactly via personId/excludePersonId — the only way to
// tell "Tom Holland" from "Tom Hollander" apart. Deliberately excludes
// titles — Browse's plain search box already covers title/person text
// search live as you type, so a title suggestion here would just be
// re-offering what's already typed rather than adding precision the way a
// genre/tag spelling or a specific person's id does.
router.get('/search-suggestions', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;

    // Decade suggestions — parsed from the query itself rather than a DB
    // lookup, so digits the user is still typing resolve to real decade
    // chips the same way a partial genre/tag resolves to an exact
    // suggestion. Two input shapes:
    //  - a numeric prefix ("1", "19", "198", "1980", "1980s") — matched
    //    against every decade's own 4-digit start year, so "198" surfaces
    //    1980s while it's still ambiguous which digit comes next, not only
    //    once the full year has been typed.
    //  - "80s"/"'80s" shorthand — resolved against the two full centuries
    //    this site's catalog actually spans (20-99 means 19XX, 00-19 means
    //    20XX), so "80s" means the 1980s and "10s" means the 2010s.
    // Capped at 5, same as tag/genre/person below, since a bare "19" or "20"
    // prefix alone matches most of the last two centuries' decades.
    let decadeSuggestions = [];
    const shorthand = q.match(/^'?(\d{2})s$/i);
    if (shorthand) {
      const n = parseInt(shorthand[1]);
      decadeSuggestions = [(n >= 20 ? 1900 : 2000) + n];
    } else {
      const digitPrefix = q.match(/^(\d{1,4})s?$/);
      if (digitPrefix) {
        const prefix = digitPrefix[1];
        const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;
        for (let d = 1900; d <= currentDecade; d += 10) {
          if (String(d).startsWith(prefix)) decadeSuggestions.push(d);
        }
        decadeSuggestions = decadeSuggestions.slice(0, 5);
      }
    }
    // Scopes which of a person's roles count toward ranking/filtering below.
    // Without this, a Books search could surface an actor of the same/
    // similar name ahead of the actual author — candidates were being ranked
    // by review count summed across ALL roles (director+cast+author)
    // regardless of which type was actually being browsed. type is whatever
    // Browse's currentApiType() sent (BOOK/MOVIE/TV_SHOW), or absent for the
    // merged Screen view and games, where role-scoping doesn't apply.
    const type = req.query.type;

    // Same scoping for genre/tag suggestions — these were previously
    // unfiltered by media type too, so typing in the Games tab could surface
    // "LitRPG" (a book-only genre) or Books could surface "Strategy"/"RPG"
    // (game-only genres), none of which exist on that type's own catalog.
    // SCREEN covers the merged Movies+TV view; a plain type value covers
    // BOOK/MOVIE/TV_SHOW/VIDEO_GAME; no type at all (the unfiltered "Browse
    // All" view spanning every media type) leaves this unfiltered too, since
    // there's no single type to scope to.
    const mediaTypesForFilter = type === 'SCREEN' ? ['MOVIE', 'TV_SHOW'] : (type ? [type] : null);
    const typeFilterSql = mediaTypesForFilter
      ? Prisma.sql`AND "mediaType"::text IN (${Prisma.join(mediaTypesForFilter)})`
      : Prisma.empty;

    // Platform suggestions — streamingProviders is only ever populated on
    // movies and TV parent rows (see the `platform` filter comment in GET
    // / above), so skip the query entirely for Books/Games rather than
    // running a jsonb scan that can never match anything there.
    const platformQuery = (type === 'BOOK' || type === 'VIDEO_GAME')
      ? Promise.resolve([])
      : prisma.$queryRaw`
          SELECT DISTINCT p->>'name' AS val
          FROM "MediaItem", jsonb_array_elements(COALESCE("streamingProviders"->'flatrate', '[]'::jsonb)) AS p
          WHERE p->>'name' ILIKE ${like} ${typeFilterSql}
          ORDER BY val LIMIT 5`;

    // Person candidates — a common name fragment ("Stephen", "King") can
    // match hundreds of Person rows, so this is a raw query rather than
    // Prisma's findMany: findMany with no orderBy and a LIMIT returns an
    // ARBITRARY slice of the matches (Postgres doesn't guarantee row order
    // for a query with no ORDER BY), which meant Stephen King — 81 authored
    // books — had no better chance of surviving that limit than any other
    // of the 481 people whose name contains "Stephen", most with a single
    // unrelated credit. Confirmed live: "Stephen" and "King" alone both
    // failed to surface him at all, while "Stephen K" (far fewer matches)
    // worked — not a matching bug, a "got unlucky with which 20 rows came
    // back" bug. Ordering by the type-relevant credit count BEFORE the
    // LIMIT, directly in SQL, fixes this regardless of how many other
    // people happen to share the fragment. VIDEO_GAME skips the query
    // entirely, same reasoning as platformQuery below — every candidate
    // gets filtered out further down anyway (this site models no
    // director/cast/author role for games), so there's nothing to rank.
    const personRelevanceExpr = type === 'BOOK'
      ? Prisma.sql`"authoredCount"`
      : (type === 'MOVIE' || type === 'TV_SHOW')
        ? Prisma.sql`("appearedCount" + "directedCount")`
        : Prisma.sql`("authoredCount" + "appearedCount" + "directedCount")`;
    // Postgres only resolves a SELECT-list alias in ORDER BY when the ORDER
    // BY item is the bare alias itself — "authoredCount" alone works, but
    // ("appearedCount" + "directedCount") does not ("column ... does not
    // exist", confirmed live testing the MOVIE/TV_SHOW branch). Wrapping in
    // a subquery makes the counts real columns of the outer query instead
    // of same-level aliases, which sidesteps that restriction entirely.
    const personCandidatesQuery = type === 'VIDEO_GAME'
      ? Promise.resolve([])
      : prisma.$queryRaw`
          SELECT * FROM (
            SELECT p.id, p.name,
              (SELECT COUNT(*)::int FROM "_AuthoredBy" WHERE "B" = p.id) AS "authoredCount",
              (SELECT COUNT(*)::int FROM "_AppearedIn" WHERE "B" = p.id) AS "appearedCount",
              (SELECT COUNT(*)::int FROM "_DirectedBy" WHERE "B" = p.id) AS "directedCount"
            FROM "Person" p
            WHERE p.name ILIKE ${like}
          ) sub
          ORDER BY ${personRelevanceExpr} DESC
          LIMIT 20`;

    const [genreRows, tagRows, personCandidates, platformRows] = await Promise.all([
      prisma.$queryRaw`SELECT DISTINCT g AS val FROM "MediaItem", unnest(genres) AS g WHERE g ILIKE ${like} ${typeFilterSql} ORDER BY g LIMIT 5`,
      prisma.$queryRaw`SELECT DISTINCT t AS val FROM "MediaItem", unnest(tags)   AS t WHERE t ILIKE ${like} ${typeFilterSql} ORDER BY t LIMIT 5`,
      personCandidatesQuery,
      platformQuery,
    ]);

    const relevantRoleCount = p => {
      if (type === 'BOOK') return p.authoredCount;
      if (type === 'MOVIE' || type === 'TV_SHOW') return p.directedCount + p.appearedCount;
      return p.directedCount + p.appearedCount + p.authoredCount;
    };
    // Drop candidates with zero relevant-role works entirely, rather than
    // just deprioritizing them — an actor with no authored books shouldn't
    // appear at all in a Books search, even ranked last. Games get no person
    // candidates at all — Person here only ever means director/cast/author,
    // none of which this site models for VIDEO_GAME, so every match would be
    // an actor/author irrelevant to games (confirmed live: browsing Games
    // and typing a common name surfaced actors/writers with nothing to do
    // with any game). The earlier BOOK/MOVIE/TV_SHOW-only check silently
    // fell through to "show everyone" for games instead of "show no one".
    const scopedCandidates = type === 'VIDEO_GAME'
      ? []
      : (type === 'BOOK' || type === 'MOVIE' || type === 'TV_SHOW')
        ? personCandidates.filter(p => relevantRoleCount(p) > 0)
        : personCandidates;

    const persons = (await Promise.all(scopedCandidates.map(async p => {
      const roleClause = type === 'BOOK'
        ? { authors: { some: { id: p.id } } }
        : (type === 'MOVIE' || type === 'TV_SHOW')
          ? { OR: [{ directors: { some: { id: p.id } } }, { cast: { some: { id: p.id } } }] }
          : { OR: [{ directors: { some: { id: p.id } } }, { cast: { some: { id: p.id } } }, { authors: { some: { id: p.id } } }] };
      const reviewCount = await prisma.review.count({ where: { mediaItem: roleClause } });
      return {
        kind: 'person', label: p.name, value: p.id, reviewCount,
        workCount: relevantRoleCount(p),
      };
    })))
      .sort((a, b) => b.reviewCount - a.reviewCount)
      .slice(0, 5);

    // Ordered tag, genre, person (actor/director/author) — tag/genre first
    // since they surface an exact spelling a user might not have known to
    // type, ahead of confirming a specific person they likely already typed.
    res.json([
      ...decadeSuggestions.map(d => ({ kind: 'decade', label: `${d}s`, value: d })),
      ...platformRows.map(r => ({ kind: 'platform', label: r.val, value: r.val })),
      ...tagRows.map(r => ({ kind: 'tag', label: r.val, value: r.val })),
      ...genreRows.map(r => ({ kind: 'genre', label: r.val, value: r.val })),
      ...persons,
    ]);
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

    // For TV seasons: merge parent cast with season-specific cast — season's
    // own cast (its billing order) first, then parent-only regulars (the
    // parent's own billing order) appended, rather than sorting the merged
    // list as one — a guest star billed #2 for this season shouldn't jump
    // ahead of the show's #1-billed lead just because they're not in this
    // season's own cast list.
    // Exclude any cast members listed in excludedCast (departed actors).
    // Exclusion is by name (case-insensitive) so it works even if Person IDs differ.
    if (item.parentId && item.parent?.cast?.length) {
      const seasonCastIds  = new Set((item.cast || []).map(p => p.id));
      const excluded       = new Set((item.excludedCast || []).map(n => n.toLowerCase()));
      const parentOnlyCast = sortByCastOrder(item.parent.cast, item.parent.castOrder).filter(p =>
        !seasonCastIds.has(p.id) && !excluded.has(p.name.toLowerCase())
      );
      item.cast = [...sortByCastOrder(item.cast, item.castOrder), ...parentOnlyCast];
    } else {
      item.cast = sortByCastOrder(item.cast, item.castOrder);
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
    // Every book sharing this series's seriesName+author cluster — used below
    // so series-level review lookups match ANY book that has ever been the
    // representative, not just item.id. A series-level review is written
    // against whatever book was the representative at the time, and adding a
    // new earlier-numbered book later shifts the representative without
    // moving existing reviews — matching strictly on item.id made such
    // reviews silently vanish. Confirmed live: this happened to real reviews
    // on the Powder Mage Trilogy, Gods of Blood and Powder, and Glass
    // Immortals the moment prequel novellas were added.
    let seriesClusterIds = null;
    if (item.mediaType === 'BOOK' && item.seriesName && item.seriesNumber != null) {
      // Same seriesName isn't sufficient on its own — two unrelated authors
      // can share an identical series name (see clusterBookSeries in the GET
      // / handler above), so this must also require sharing an author with
      // THIS book, or an unrelated same-named series would get pulled in.
      const authorIds = (item.authors || []).map(a => a.id);
      const clusterBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: item.seriesName, seriesNumber: { not: null }, verified: true, authors: { some: { id: { in: authorIds } } } },
        orderBy: { seriesNumber: 'asc' },
        select: { id: true, slug: true, seriesNumber: true },
      });
      const lowestInSeries = pickSeriesRepresentative(clusterBooks);
      // ?book=1 means "show this as an individual book" even if it's the series representative
      const forceIndividual = req.query.book === '1';
      isBookSeries  = !forceIndividual && lowestInSeries?.id === item.id;
      seriesRepSlug = lowestInSeries?.slug || null;
      if (isBookSeries) seriesClusterIds = clusterBooks.map(b => b.id);
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
      ? { mediaItemId: { in: seriesClusterIds }, seasonNumber: 0, visibility: 'PUBLIC' }
      : { mediaItemId: item.id, seasonNumber: null, visibility: 'PUBLIC' };
    // Excludes seasonNumber:0 (series-level review sentinel) even in the
    // plain/individual default case below — a book that's normally the series
    // representative can carry a genuine series-level review on this very
    // row, and without this exclusion, viewing it individually (?book=1)
    // blended that series review into the book's own avgRating/reviewCount
    // (confirmed live: Unsouled showed 8.0/2 reviews — its own 7 averaged
    // with Cradle's series-level 9 — instead of just its own 7/1).
    let statsWhere = { mediaItemId: item.id, visibility: 'PUBLIC', OR: [{ seasonNumber: null }, { seasonNumber: { not: 0 } }] };
    let seriesBooks = [];

    if (isTvParent && item.seasonEntries?.length) {
      const seasonIds = item.seasonEntries.map(s => s.id);
      statsWhere = { mediaItemId: { in: seasonIds }, visibility: 'PUBLIC' };
    } else if (isBookSeries && item.seriesName) {
      // Fetch all books in this series ordered by seriesNumber — author
      // overlap required for the same reason as the lowestInSeries query above.
      const authorIds = (item.authors || []).map(a => a.id);
      seriesBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: item.seriesName, verified: true, authors: { some: { id: { in: authorIds } } } },
        select: {
          id: true, title: true, slug: true,
          seriesNumber: true, releaseYear: true, imageUrl: true,
          // seasonNumber: {not: 0} excludes series-level reviews — otherwise the
          // representative book's own count here double-counts once a series-
          // level review exists too, since both share that book's mediaItemId.
          _count: { select: { reviews: { where: { visibility: 'PUBLIC', OR: [{ seasonNumber: null }, { seasonNumber: { not: 0 } }] } } } },
        },
        orderBy: { seriesNumber: 'asc' },
      });
      const seriesBookIds = seriesBooks.map(b => b.id);
      // Exclude seasonNumber:0 (series-level reviews) — these per-book stats
      // should only count actual individual-book ratings. Without this, the
      // representative book's own row double-counts once a series-level
      // review exists too, since both share that same mediaItemId.
      statsWhere = { mediaItemId: { in: seriesBookIds }, OR: [{ seasonNumber: null }, { seasonNumber: { not: 0 } }], visibility: 'PUBLIC' };
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
        // seasonNumber: {not: 0} — same reasoning as the _count above: don't
        // blend the representative book's series-level review into its own
        // individual rating/count.
        where: { mediaItemId: { in: bookIds }, OR: [{ seasonNumber: null }, { seasonNumber: { not: 0 } }], visibility: 'PUBLIC' },
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
        ? { userId: req.user.id, mediaItemId: { in: seriesClusterIds }, seasonNumber: 0 }
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

    // Directors/authors alphabetically in JS — Prisma doesn't support orderBy
    // on implicit many-to-many relations, and these lists are short enough
    // that alphabetical is fine. Cast was already sorted into billing order
    // above (sortByCastOrder, before the season/parent merge) — don't
    // re-sort it alphabetically here, that's the exact bug this replaced.
    const sortByName = (a, b) => a.name.localeCompare(b.name);
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
        // A genuine series-level review (seriesLevelStats — someone reviewed
        // the series/show as a whole) outranks the average across individual
        // books/seasons (stats), mirroring the same priority the browse-list
        // card uses (effectiveRating: directRatingMap before
        // bookSeriesRatingMap). Previously seriesLevelStats was computed but
        // never actually used here, so a series-level review's rating never
        // showed up in the page's own displayed average at all.
        avgRating:    (seriesLevelStats?._count.rating > 0) ? seriesLevelStats._avg.rating : stats._avg.rating,
        reviewCount:  (seriesLevelStats?._count.rating > 0) ? seriesLevelStats._count.rating : stats._count.rating,
        // The genuine series-level review's own avg/count, exposed separately
        // from the fields above — item.html's series-children section shows
        // "Series/Show Rating" (this) alongside "Avg Book/Season Rating"
        // (computed client-side from seriesBooksData/seasonEntries) side by
        // side, rather than the single blended value above. Previously these
        // fields didn't exist on the response at all, so that section always
        // fell back to only ever displaying the average-across-books value.
        seriesAvgRating:   (seriesLevelStats?._count.rating > 0) ? seriesLevelStats._avg.rating : null,
        seriesReviewCount: seriesLevelStats?._count.rating || 0,
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
    const item = await prisma.mediaItem.findUnique({
      where: { slug: req.params.slug },
      include: { authors: { select: { id: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    const page = parseInt(req.query.page) || 1;
    const take = 20;
    let seasonFilter = req.query.season ? { seasonNumber: parseInt(req.query.season) } : {};

    // A book series page reuses the lowest-numbered book's own MediaItem row —
    // its reviews list must show series-level reviews (seasonNumber: 0) only,
    // NOT that book's own individual review (seasonNumber: null), which would
    // otherwise leak in as if someone had reviewed the whole series. Mirrors
    // the isBookSeries check in GET /:slug. Confirmed live: the Cradle series
    // page was showing book 1's ("Unsouled") own review as if it were a
    // series review, because this endpoint applied no season filter at all.
    //
    // seriesReviewMediaItemIds: which "representative" book actually holds the
    // lowest seriesNumber shifts over time — e.g. adding a prequel novella
    // numbered 0 to a series whose flagship book was previously #1 makes the
    // novella the new representative. A series-level review, though, is
    // always written against WHATEVER was the representative at review time,
    // so an existing review's mediaItemId can point at a book that is no
    // longer the representative. Matching strictly on `item.id` made such
    // reviews silently disappear the moment a new earlier-numbered book was
    // added — confirmed live: this happened to real reviews on the Powder
    // Mage Trilogy, Gods of Blood and Powder, and Glass Immortals the moment
    // prequel novellas were added, and to three more series in earlier
    // sessions before anyone noticed. Matching against every book in the
    // cluster (not just the current representative's own id) makes the
    // lookup independent of which specific book currently holds the lowest
    // number, so this class of bug can't recur.
    let seriesReviewMediaItemIds = null;
    if (item.mediaType === 'BOOK' && item.seriesName && item.seriesNumber != null) {
      const forceIndividual = req.query.book === '1';
      // Author overlap required, not just seriesName — see clusterBookSeries
      // in GET / above (two unrelated authors can share an identical name).
      const authorIds = (item.authors || []).map(a => a.id);
      const clusterBooks = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: item.seriesName, seriesNumber: { not: null }, verified: true, authors: { some: { id: { in: authorIds } } } },
        orderBy: { seriesNumber: 'asc' },
        select: { id: true, seriesNumber: true },
      });
      const lowestInSeries = pickSeriesRepresentative(clusterBooks);
      const isBookSeries = !forceIndividual && lowestInSeries?.id === item.id;
      seasonFilter = { seasonNumber: isBookSeries ? 0 : null };
      if (isBookSeries) seriesReviewMediaItemIds = clusterBooks.map(b => b.id);
    }

    // Friends-only filter — restrict to reviews by friends of the logged-in user
    let userFilter = {};
    const friendsOnly      = req.query.friendsOnly === 'true';
  // excludeFriends: comma-separated emails to exclude from friend ratings
  const excludeFriends   = req.query.excludeFriends
    ? req.query.excludeFriends.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  // consumedWithin: only count reviews where dateConsumed >= N months ago
  // Format: "12m" = 12 months, "2y" = 2 years
  const consumedWithin   = req.query.consumedWithin || null;
    let friendIds = [];
    if (req.user) {
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
    }
    if (friendsOnly && req.user) {
      userFilter = { userId: { in: friendIds.length ? friendIds : ['__none__'] } };
    }

    const visibilityFilter = (friendsOnly && req.user)
      ? { in: ['PUBLIC', 'FRIENDS_ONLY'] }
      : 'PUBLIC';

    // Someone with a private profile shouldn't have their writing published to
    // readers who can't open that profile — this list is the other place a
    // review's text is shown publicly besides the Everyone feed, and unlike
    // the feed these pages are crawlable (see prerender.js/sitemap.js). Same
    // rule as feed.js and users.js's GET /:username: public, yours, or a
    // friend's. Only the ratings-derived aggregates further up are unaffected,
    // deliberately — a hidden review still counts toward the item's average,
    // matching how the site treats ratings elsewhere.
    const authorVisible = (friendsOnly && req.user) ? null : {
      OR: [
        { user: { profilePublic: true } },
        ...(req.user ? [{ userId: req.user.id }, { userId: { in: friendIds } }] : []),
      ],
    };

    const where = {
      mediaItemId: seriesReviewMediaItemIds ? { in: seriesReviewMediaItemIds } : item.id,
      visibility: visibilityFilter,
      ...seasonFilter,
      ...userFilter,
      ...(authorVisible && { AND: [authorVisible] }),
    };
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
