// src/routes/reviews.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
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
], async (req, res, next) => {
  if (!ok(req, res)) return;
  const { mediaItemId, rating, seasonNumber, dateConsumed, reviewText, spoilerText, visibility, isRevisit } = req.body;
  try {
    const media = await prisma.mediaItem.findUnique({ where: { id: mediaItemId }, include: { authors: { select: { id: true } } } });
    if (!media) return res.status(404).json({ error: 'Media item not found' });

    const verdict = ratingToVerdict(parseInt(rating));
    const vis = visibility || req.user.defaultVisibility || 'PUBLIC';
    const season = (seasonNumber !== null && seasonNumber !== undefined && seasonNumber !== '') ? parseInt(seasonNumber) : null;

    // Convert dateConsumed string to a real Date object if provided,
    // otherwise leave as null — the field is optional
    const consumed = dateConsumed ? new Date(dateConsumed) : null;

    if (consumed) {
      if (consumed.getTime() > Date.now()) {
        return res.status(422).json({ error: 'Date consumed cannot be in the future' });
      }
      if (media.releaseYear && consumed.getFullYear() < media.releaseYear) {
        return res.status(422).json({ error: `Date consumed cannot be before this was released (${media.releaseYear})` });
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
      existing = await prisma.review.findFirst({
        where: { userId: req.user.id, mediaItemId: { in: clusterIds }, seasonNumber: 0 },
      });
    } else {
      existing = await prisma.review.findFirst({
        where: { userId: req.user.id, mediaItemId, seasonNumber: season },
      });
    }

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
          dateConsumed: consumed,
          reviewText, spoilerText, visibility: vis, verdict,
          isRevisit: ratingChanged ? true : existing.isRevisit,
          previousRating: ratingChanged ? existing.rating : existing.previousRating,
        },
        include: reviewInclude,
      });
    } else {
      // Create a brand new review
      review = await prisma.review.create({
        data: {
          userId: req.user.id, mediaItemId,
          rating: parseInt(rating),
          seasonNumber: season,
          dateConsumed: consumed,        // store when they consumed it
          reviewText, spoilerText, visibility: vis, verdict, isRevisit: false,
        },
        include: reviewInclude,
      });
      await notifyFriends(req.user.id, review.id, media.title).catch(console.error);
    }

    res.status(existing ? 200 : 201).json(review);
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

module.exports = router;
