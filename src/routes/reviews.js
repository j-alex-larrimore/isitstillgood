// src/routes/reviews.js
const router = require('express').Router();
const { randomUUID } = require('crypto');
const { body, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { syncBadges, presentBadge, EARLY_REVIEW_LIMIT } = require('../lib/badges');
// Reads through `prisma` can't see drafts (see src/lib/prisma.js). This route
// is the one place that legitimately needs to — an author saving over, reading
// back, or publishing their own unpublished review.
const { prismaWithDrafts } = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

function ratingToVerdict(r) {
  const words = {
    10: 'Perfect', 9: 'Excellent', 8: 'Great', 7: 'Good', 6: 'Solid',
    5: 'Fine', 4: 'Mediocre', 3: 'Bad', 2: 'Awful', 1: 'The Worst',
  };
  return words[Math.round(r)] || 'Unrated';
}

// ─── GET /api/reviews/:id ─────────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const review = await prisma.review.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        mediaItem: {
          select: { id: true, title: true, mediaType: true, releaseYear: true, imageUrl: true, slug: true, genres: true },
        },
        reactions: { select: { userId: true, emoji: true } },
        comments: {
          where: { parentId: null },
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
            replies: {
              include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!review) return res.status(404).json({ error: 'Review not found' });

    // findUnique can't carry the client extension's draft filter (its `where`
    // only takes unique fields), so this is one of the few places that has to
    // check by hand. An unpublished review doesn't exist to anyone but its
    // author — 404 rather than 403, since acknowledging it would leak that the
    // person is drafting something about this title.
    if (review.isDraft && review.userId !== req.user?.id) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // A PUBLIC review still isn't public reading when its author's profile
    // isn't — same rule as feed.js, media.js and users.js. Lower exposure
    // than those, since it needs the review's own opaque id rather than
    // being listed anywhere, but the rule shouldn't differ by endpoint.
    if (review.userId !== req.user?.id) {
      const author = await prisma.user.findUnique({
        where: { id: review.userId },
        select: { profilePublic: true },
      });
      if (!author?.profilePublic) {
        const areFriends = req.user && await prisma.friendship.findFirst({
          where: { status: 'ACCEPTED', OR: [
            { initiatorId: req.user.id, receiverId: review.userId },
            { initiatorId: review.userId, receiverId: req.user.id },
          ]},
        });
        if (!areFriends) return res.status(403).json({ error: 'friends_only' });
      }
    }

    if (review.visibility === 'PRIVATE' && review.userId !== req.user?.id) {
      return res.status(403).json({ error: 'This review is private' });
    }
    if (review.visibility === 'FRIENDS_ONLY' && review.userId !== req.user?.id) {
      if (!req.user) return res.status(403).json({ error: 'Friends only' });
      const areFriends = await prisma.friendship.findFirst({
        where: { status: 'ACCEPTED', OR: [
          { initiatorId: req.user.id, receiverId: review.userId },
          { initiatorId: review.userId, receiverId: req.user.id },
        ]},
      });
      if (!areFriends) return res.status(403).json({ error: 'Friends only' });
    }

    res.json(review);
  } catch (err) { next(err); }
});

// ─── POST /api/reviews ─── Create or update ───────────────────────────────
router.post('/', requireAuth, [
  body('mediaItemId').notEmpty(),
  body('rating').isInt({ min: 1, max: 10 }),
  body('seasonNumber').optional({ nullable: true }).isInt({ min: 0 }),
  // dateConsumed is when they last watched/read/played it — optional ISO date string
  body('dateConsumed').optional({ nullable: true }).isISO8601().withMessage('dateConsumed must be a valid date'),
  body('reviewText').optional().trim().isLength({ max: 5000 }),
  body('spoilerText').optional().trim().isLength({ max: 3000 }),
  body('visibility').optional().isIn(['PUBLIC', 'FRIENDS_ONLY', 'PRIVATE']),
  body('isRevisit').optional().isBoolean(),
  body('isDraft').optional().isBoolean(),
  // Keep this review out of the activity feed. Not the same as visibility:
  // it stays public, still counts toward the title's score and still appears
  // on the title's own page — it is simply not broadcast.
  body('hiddenFromFeed').optional().isBoolean(),
  // Also keep it off the author's public profile list.
  body('hiddenFromProfile').optional().isBoolean(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const saved = await saveReview({ user: req.user, body: req.body });
    if (saved.error) return res.status(saved.status).json({ error: saved.error });
    const earnedBadges = await earnBadges(req.user.id);
    res.status(saved.created ? 201 : 200)
       .json(earnedBadges?.length ? { ...saved.review, earnedBadges } : saved.review);
  } catch (err) { next(err); }
});

// Write one review. Shared by POST / and POST /batch so the two cannot drift
// — everything below (first-review credit, the book-series cluster lookup,
// draft handling, revisit detection) is the kind of logic that goes subtly
// wrong in a second copy nobody remembers to update.
//
// batchId / isBatchLead are set by the batch caller only. notify is off for
// the followers of a batch: friends hear once about the batch, not once per
// title, which is the same rule imports.js already applies.
async function saveReview({ user, body, batchId = null, isBatchLead = false, notify = true }) {
  const { mediaItemId, rating, seasonNumber, dateConsumed, reviewText, spoilerText, visibility, isRevisit, isDraft } = body;
  const saveAsDraft = isDraft === true || isDraft === 'true';
  {
    const media = await prisma.mediaItem.findUnique({ where: { id: mediaItemId }, include: { authors: { select: { id: true } } } });
    if (!media) return { error: 'Media item not found', status: 404 };

    const verdict = ratingToVerdict(parseInt(rating));
    const vis = visibility || user.defaultVisibility || 'PUBLIC';
    const season = (seasonNumber !== null && seasonNumber !== undefined && seasonNumber !== '') ? parseInt(seasonNumber) : null;

    // Convert dateConsumed string to a real Date object if provided,
    // otherwise leave as null — the field is optional
    const consumed = dateConsumed ? new Date(dateConsumed) : null;

    // "Not mentioned" and "deliberately cleared" are different answers, and
    // the update below has to tell them apart. A caller that never names the
    // field — the head-to-head builder, which only ever sends a rating —
    // must leave an existing date alone; a caller that sends it empty is
    // clearing it on purpose.
    const dateWasSubmitted = Object.prototype.hasOwnProperty.call(body, 'dateConsumed');

    if (consumed) {
      if (consumed.getTime() > Date.now()) {
        return { error: 'Date consumed cannot be in the future', status: 422 };
      }
      if (media.releaseYear && consumed.getFullYear() < media.releaseYear) {
        return { error: `Date consumed cannot be before this was released (${media.releaseYear})`, status: 422 };
      }
    }

    // Use findFirst with explicit where clause — findUnique with a composite key
    // fails when seasonNumber is null because Prisma can't match null in a compound key
    //
    // season === 0 is a book-series-level review — its mediaItemId is
    // whatever book currently acts as the series representative (the
    // lowest-numbered book), which can SHIFT later if an earlier-numbered
    // prequel/novella gets added. If the existing-review lookup matched only
    // the exact mediaItemId the client just submitted, an edit made after
    // such a shift would silently create a duplicate review instead of
    // updating the original (whose mediaItemId now points at a book that's
    // no longer the representative) — confirmed live as the root cause of
    // real reviews on the Powder Mage Trilogy, Gods of Blood and Powder, and
    // Glass Immortals appearing to vanish. Searching the whole author-overlap
    // cluster for series-level reviews, rather than one exact id, means an
    // edit always finds and updates the user's real existing review — and
    // refreshing its mediaItemId below keeps it self-healing on every save.
    let existing;
    if (season === 0 && media.mediaType === 'BOOK' && media.seriesName) {
      const authorIds = media.authors.map(a => a.id);
      const clusterIds = (await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', seriesName: media.seriesName, authors: { some: { id: { in: authorIds } } } },
        select: { id: true },
      })).map(b => b.id);
      // Draft-aware: reads through `prisma` can't see drafts, so saving over
      // an existing draft would miss it here and try to INSERT a second row,
      // tripping the user+item+season unique constraint.
      existing = await prismaWithDrafts.review.findFirst({
        where: { userId: user.id, mediaItemId: { in: clusterIds }, seasonNumber: 0 },
      });
    } else {
      // Draft-aware: reads through `prisma` can't see drafts, so saving over
      // an existing draft would miss it here and try to INSERT a second row,
      // tripping the user+item+season unique constraint.
      existing = await prismaWithDrafts.review.findFirst({
        where: { userId: user.id, mediaItemId, seasonNumber: season },
      });
    }

    // Is this the first time anyone has publicly reviewed this item?
    //
    // Decided here, before the write, and only when the review is actually
    // going to be visible — a draft is not a contribution to the catalogue
    // yet, and a private one is not one anybody else can see. Their own prior
    // review is excluded so editing it does not make them compete with
    // themselves for the credit.
    // hiddenFromProfile implies hiddenFromFeed — absent from a profile but
    // present in the feed would be incoherent, so the stronger choice wins
    // rather than the client being trusted to send both.
    const hiddenFromProfile = body.hiddenFromProfile === undefined
      ? (existing ? existing.hiddenFromProfile : false)
      : !!body.hiddenFromProfile;
    const hiddenFromFeed = hiddenFromProfile || (body.hiddenFromFeed === undefined
      ? (existing ? existing.hiddenFromFeed : false)
      : !!body.hiddenFromFeed);

    let isFirstReview = !!(existing && existing.isFirstReview);
    let isEarlyReview = !!(existing && existing.isEarlyReview);

    // Only worked out once. Already earned means already earned — never taken
    // away by a later edit, a visibility change, or saving over it as a draft.
    if (!isFirstReview && !isEarlyReview && !saveAsDraft && vis === 'PUBLIC') {
      const priorPublic = await prisma.review.count({
        where: {
          mediaItemId, isDraft: false, visibility: 'PUBLIC',
          NOT: { userId: user.id },
        },
      });
      isFirstReview = priorPublic === 0;
      isEarlyReview = priorPublic < EARLY_REVIEW_LIMIT;
    }
    // The stronger claim always implies the weaker one.
    if (isFirstReview) isEarlyReview = true;

    let review;
    if (existing) {
      // Only mark as revisit if the rating actually changed
      const newRating = parseInt(rating);
      const ratingChanged = newRating !== existing.rating;
      review = await prisma.review.update({
        where: { id: existing.id },
        data: {
          // Refresh mediaItemId to whatever was just submitted — for a
          // series-level review this keeps it pinned to the CURRENT
          // representative on every save, so it can't drift back out of
          // sync even if the representative shifted since the last edit.
          mediaItemId,
          rating: newRating,
          // Omitted entirely when the caller said nothing about it, so
          // Prisma leaves the stored date alone instead of nulling it.
          ...(dateWasSubmitted ? { dateConsumed: consumed } : {}),
          reviewText, spoilerText, visibility: vis, verdict,
          isDraft: saveAsDraft,
          // A draft being saved over isn't a revisit — that only means "I
          // changed my mind about something I'd already published".
          isRevisit: existing.isDraft ? false : (ratingChanged ? true : existing.isRevisit),
          previousRating: existing.isDraft ? null : (ratingChanged ? existing.rating : existing.previousRating),
          isFirstReview,
          hiddenFromFeed, hiddenFromProfile,
          // Re-rating something inside a batch moves it into that batch, so
          // the feed shows it under the save that changed it rather than
          // leaving a stale separate card from whenever it was first rated.
          ...(batchId ? { batchId, isBatchLead } : {}),
        },
        include: reviewInclude,
      });
      // Publishing a draft is the moment friends should hear about it — the
      // create branch below never fired for this review, because it already
      // existed as a draft.
      if (notify && existing.isDraft && !saveAsDraft) {
        await notifyFriends(user.id, review.id, media.title).catch(console.error);
      }
    } else {
      // Create a brand new review.
      //
      // The existence check above is a read followed by a write, so two
      // requests for the same item can both find nothing and both insert.
      // That is no longer silent — the unique index now covers a null
      // seasonNumber (see the NULLS NOT DISTINCT migration) — but a
      // rejection is not something to hand back to someone who only tried
      // to rate a film. P2002 means the other request got there first, so
      // take what it wrote and apply this rating to it.
      try {
      review = await prisma.review.create({
        data: {
          userId: user.id, mediaItemId,
          rating: parseInt(rating),
          seasonNumber: season,
          dateConsumed: consumed,        // store when they consumed it
          reviewText, spoilerText, visibility: vis, verdict, isRevisit: false,
          isDraft: saveAsDraft,
          isFirstReview,
          hiddenFromFeed, hiddenFromProfile,
          batchId, isBatchLead,
        },
        include: reviewInclude,
      });
      } catch (e) {
        if (e.code !== 'P2002') throw e;
        const winner = await prismaWithDrafts.review.findFirst({
          where: { userId: user.id, mediaItemId, seasonNumber: season },
        });
        if (!winner) throw e;
        review = await prisma.review.update({
          where: { id: winner.id },
          data: {
            rating: parseInt(rating),
            reviewText, spoilerText, visibility: vis, verdict,
            isDraft: saveAsDraft, hiddenFromFeed, hiddenFromProfile,
            ...(dateWasSubmitted ? { dateConsumed: consumed } : {}),
            ...(batchId ? { batchId, isBatchLead } : {}),
          },
          include: reviewInclude,
        });
        // The other request already announced it; saying so twice is the
        // thing this whole path exists to avoid.
        return { review, created: false, feedEligible: !saveAsDraft && !hiddenFromFeed && vis !== 'PRIVATE' };
      }
      // Nobody is told about an unpublished review.
      if (notify && !saveAsDraft) {
        await notifyFriends(user.id, review.id, media.title).catch(console.error);
      }
    }

    return { review, created: !existing, feedEligible: !saveAsDraft && !hiddenFromFeed && vis !== 'PRIVATE' };
  }
}

// Badges are recognition, not bookkeeping: a failure here must never cost
// someone the review they just wrote, so it is awaited (the response should
// reflect what they earned) but never allowed to reject.
//
// Returned ready to display — label, blurb and all. The page celebrating
// this should not have to re-derive "Pathfinder II" from a code and a
// tier, because then the rules would live in two places and drift.
//
// Run once per request, not once per review: a twenty-title batch would
// otherwise re-derive every badge twenty times and report the same one
// earned on each pass.
async function earnBadges(userId) {
  const earned = await syncBadges(prisma, userId).catch(err => {
    console.error('badge sync failed', err);
    return [];
  });
  if (!earned.length) return undefined;
  const rows = await prisma.userBadge.findMany({
    where: { userId, code: { in: earned.map(e => e.code) } },
  });
  return rows.map(presentBadge).filter(Boolean);
}

// ─── POST /api/reviews/batch ──────────────────────────────────────────────
// Several ratings saved as one action — what saving a VS card is.
//
// Two problems this solves, both of which are the same problem. Rating ten
// titles used to be ten requests, which is a burst of writes this Postgres
// has fallen over under before (see the Railway volume note in CLAUDE.md),
// and ten feed cards and ten friend notifications, which buries everyone
// else's actual reviews. imports.js already decided the principle: one
// event about a person, not N events about N films.
//
// So: one request, written sequentially, sharing a batchId, with exactly
// one row marked isBatchLead for the feed to hang the group on, and one
// notification.
//
// Partial success is reported rather than rolled back. If eight of ten
// land, those eight are real opinions the person expressed and throwing
// them away to punish the two would be the worse outcome — the response
// names what failed so the client can keep those and retry.
const BATCH_MAX = 50;

router.post('/batch', requireAuth, [
  body('reviews').isArray({ min: 1, max: BATCH_MAX })
    .withMessage(`reviews must be an array of 1 to ${BATCH_MAX} items`),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const batchId = randomUUID();
    const saved = [], failed = [];
    let leadAssigned = false;

    for (const item of req.body.reviews) {
      if (!item || typeof item !== 'object' || !item.mediaItemId) {
        failed.push({ mediaItemId: item && item.mediaItemId, error: 'mediaItemId is required' });
        continue;
      }
      const n = parseInt(item.rating, 10);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        failed.push({ mediaItemId: item.mediaItemId, error: 'rating must be 1-10' });
        continue;
      }
      try {
        // The lead has to be a review the feed would actually show. Handing
        // it to a draft, a private rating or one hidden from the feed would
        // hide the whole group behind it.
        const result = await saveReview({
          user: req.user, body: item, batchId,
          isBatchLead: !leadAssigned, notify: false,
        });
        if (result.error) { failed.push({ mediaItemId: item.mediaItemId, error: result.error }); continue; }
        if (!leadAssigned && result.feedEligible) leadAssigned = true;
        else if (!leadAssigned) {
          // Provisionally marked lead but not feed-eligible after all; clear
          // it so a later eligible row in this batch can take the role.
          await prisma.review.update({ where: { id: result.review.id }, data: { isBatchLead: false } });
          result.review.isBatchLead = false;
        }
        saved.push(result.review);
      } catch (err) {
        console.error('batch review failed', item.mediaItemId, err.message);
        failed.push({ mediaItemId: item.mediaItemId, error: 'could not be saved' });
      }
    }

    // One notification for the batch, pointing at the lead — the row the
    // feed will show. Nothing to announce if nothing in it was publishable.
    const lead = saved.find(r => r.isBatchLead);
    if (lead) {
      await notifyFriends(req.user.id, lead.id, lead.mediaItem ? lead.mediaItem.title : '').catch(console.error);
    }

    const earnedBadges = await earnBadges(req.user.id);
    res.status(saved.length ? 201 : 422).json({
      batchId, saved: saved.length, failed,
      reviews: saved,
      ...(earnedBadges?.length ? { earnedBadges } : {}),
    });
  } catch (err) { next(err); }
});

// ─── DELETE /api/reviews/:id ──────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const review = await prisma.review.findUnique({ where: { id: req.params.id } });
    if (!review) return res.status(404).json({ error: 'Not found' });
    if (review.userId !== req.user.id) return res.status(403).json({ error: 'Not your review' });
    await prisma.review.delete({ where: { id: req.params.id } });
    res.json({ message: 'Review deleted' });
  } catch (err) { next(err); }
});

// ─── POST /api/reviews/:id/react ──────────────────────────────────────────
router.post('/:id/react', requireAuth, [
  body('emoji').trim().notEmpty().isLength({ max: 8 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const key = { userId: req.user.id, reviewId: req.params.id, emoji: req.body.emoji };
    const existing = await prisma.reaction.findUnique({ where: { userId_reviewId_emoji: key } });
    if (existing) {
      await prisma.reaction.delete({ where: { userId_reviewId_emoji: key } });
      res.json({ action: 'removed', emoji: req.body.emoji });
    } else {
      await prisma.reaction.create({ data: key });
      res.json({ action: 'added', emoji: req.body.emoji });
    }
  } catch (err) { next(err); }
});

// ─── POST /api/reviews/:id/comments ──────────────────────────────────────
router.post('/:id/comments', requireAuth, [
  body('body').trim().isLength({ min: 1, max: 2000 }),
  body('parentId').optional().trim(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const comment = await prisma.comment.create({
      data: { userId: req.user.id, reviewId: req.params.id, body: req.body.body, parentId: req.body.parentId || null },
      include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    res.status(201).json(comment);
  } catch (err) { next(err); }
});

// ─── DELETE /api/reviews/:reviewId/comments/:commentId ───────────────────
router.delete('/:reviewId/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
    if (!comment) return res.status(404).json({ error: 'Not found' });
    if (comment.userId !== req.user.id) return res.status(403).json({ error: 'Not your comment' });
    await prisma.comment.delete({ where: { id: req.params.commentId } });
    res.json({ message: 'Comment deleted' });
  } catch (err) { next(err); }
});

const reviewInclude = {
  mediaItem: { select: { id: true, title: true, mediaType: true, releaseYear: true, imageUrl: true, slug: true } },
  _count: { select: { reactions: true, comments: true } },
};

async function notifyFriends(userId, reviewId, mediaTitle) {
  const friendships = await prisma.friendship.findMany({
    where: { status: 'ACCEPTED', OR: [{ initiatorId: userId }, { receiverId: userId }] },
  });
  const friendIds = friendships.map(f => f.initiatorId === userId ? f.receiverId : f.initiatorId);
  if (!friendIds.length) return;
  await prisma.notification.createMany({
    data: friendIds.map(fid => ({
      userId: fid, type: 'NEW_FRIEND_REVIEW',
      payload: { reviewId, mediaTitle, fromUserId: userId },
    })),
  });
}

// ─── GET /api/reviews/drafts/mine ─────────────────────────────────────────
// Your own unpublished reviews. Two path segments so it can't be swallowed by
// the single-segment /:id route above.
//
// Uses prismaWithDrafts because the shared client filters drafts out of every
// read by design — this is one of the few places that's supposed to see them,
// and it's scoped to req.user.id so it can only ever return your own.
router.get('/drafts/mine', requireAuth, async (req, res, next) => {
  try {
    const drafts = await prismaWithDrafts.review.findMany({
      where: { userId: req.user.id, isDraft: true },
      include: {
        mediaItem: {
          select: { id: true, title: true, slug: true, mediaType: true, releaseYear: true, imageUrl: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    res.json({ drafts, total: drafts.length });
  } catch (err) { next(err); }
});

module.exports = router;
