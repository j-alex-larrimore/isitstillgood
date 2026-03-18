// src/routes/reviews.js
const router = require('express').Router();
const { body, query, param, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

/** Map a numeric rating 1-10 to a verdict label */
function ratingToVerdict(rating) {
  if (rating >= 9) return 'TIMELESS';
  if (rating >= 7) return 'STILL_GOOD';
  if (rating >= 4) return 'MIXED';
  return 'NOT_GOOD';
}

// ─── GET /api/reviews/:id ─── Single review ─────────────────────────────
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const review = await prisma.review.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        mediaItem: {
          select: {
            id: true, title: true, mediaType: true, releaseYear: true,
            imageUrl: true, slug: true, genres: true,
          },
        },
        reactions: {
          select: { userId: true, emoji: true },
        },
        comments: {
          where: { parentId: null },
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
            replies: {
              include: {
                user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!review) return res.status(404).json({ error: 'Review not found' });

    // Visibility check
    if (review.visibility === 'PRIVATE' && review.userId !== req.user?.id) {
      return res.status(403).json({ error: 'This review is private' });
    }
    if (review.visibility === 'FRIENDS_ONLY' && review.userId !== req.user?.id) {
      if (!req.user) return res.status(403).json({ error: 'Friends only' });
      const areFriends = await prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { initiatorId: req.user.id, receiverId: review.userId },
            { initiatorId: review.userId, receiverId: req.user.id },
          ],
        },
      });
      if (!areFriends) return res.status(403).json({ error: 'Friends only' });
    }

    res.json(review);
  } catch (err) { next(err); }
});

// ─── POST /api/reviews ─── Create or update review ──────────────────────
router.post('/', requireAuth, [
  body('mediaItemId').notEmpty(),
  body('rating').isInt({ min: 1, max: 10 }),
  body('reviewText').optional().trim().isLength({ max: 5000 }),
  body('spoilerText').optional().trim().isLength({ max: 3000 }),
  body('visibility').optional().isIn(['PUBLIC','FRIENDS_ONLY','PRIVATE']),
  body('isRevisit').optional().isBoolean(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  const { mediaItemId, rating, reviewText, spoilerText, visibility, isRevisit } = req.body;
  try {
    const media = await prisma.mediaItem.findUnique({ where: { id: mediaItemId } });
    if (!media) return res.status(404).json({ error: 'Media item not found' });

    // Check for existing review
    const existing = await prisma.review.findUnique({
      where: { userId_mediaItemId: { userId: req.user.id, mediaItemId } },
    });

    const verdict = ratingToVerdict(parseInt(rating));
    const vis = visibility || req.user.defaultVisibility || 'PUBLIC';

    let review;
    if (existing) {
      // Update / revisit
      review = await prisma.review.update({
        where: { id: existing.id },
        data: {
          rating: parseInt(rating),
          reviewText,
          spoilerText,
          visibility: vis,
          verdict,
          isRevisit: isRevisit || (existing.rating !== parseInt(rating)),
          previousRating: isRevisit ? existing.rating : existing.previousRating,
        },
        include: reviewInclude,
      });
    } else {
      review = await prisma.review.create({
        data: {
          userId: req.user.id,
          mediaItemId,
          rating: parseInt(rating),
          reviewText,
          spoilerText,
          visibility: vis,
          verdict,
          isRevisit: false,
        },
        include: reviewInclude,
      });

      // Notify friends of the new review
      await notifyFriends(req.user.id, review.id, media.title).catch(console.error);
    }

    res.status(existing ? 200 : 201).json(review);
  } catch (err) { next(err); }
});

// ─── DELETE /api/reviews/:id ─────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const review = await prisma.review.findUnique({ where: { id: req.params.id } });
    if (!review) return res.status(404).json({ error: 'Not found' });
    if (review.userId !== req.user.id) return res.status(403).json({ error: 'Not your review' });
    await prisma.review.delete({ where: { id: req.params.id } });
    res.json({ message: 'Review deleted' });
  } catch (err) { next(err); }
});

// ─── POST /api/reviews/:id/react ─── Toggle emoji reaction ──────────────
router.post('/:id/react', requireAuth, [
  body('emoji').trim().notEmpty().isLength({ max: 8 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  const { emoji } = req.body;
  try {
    const key = { userId: req.user.id, reviewId: req.params.id, emoji };
    const existing = await prisma.reaction.findUnique({ where: { userId_reviewId_emoji: key } });
    if (existing) {
      await prisma.reaction.delete({ where: { userId_reviewId_emoji: key } });
      res.json({ action: 'removed', emoji });
    } else {
      await prisma.reaction.create({ data: key });
      res.json({ action: 'added', emoji });
    }
  } catch (err) { next(err); }
});

// ─── POST /api/reviews/:id/comments ─── Add a comment ───────────────────
router.post('/:id/comments', requireAuth, [
  body('body').trim().isLength({ min: 1, max: 2000 }),
  body('parentId').optional().trim(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const comment = await prisma.comment.create({
      data: {
        userId: req.user.id,
        reviewId: req.params.id,
        body: req.body.body,
        parentId: req.body.parentId || null,
      },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
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

// ─── Helpers ──────────────────────────────────────────────────────────────
const reviewInclude = {
  mediaItem: {
    select: { id: true, title: true, mediaType: true, releaseYear: true, imageUrl: true, slug: true },
  },
  _count: { select: { reactions: true, comments: true } },
};

async function notifyFriends(userId, reviewId, mediaTitle) {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ initiatorId: userId }, { receiverId: userId }],
    },
  });
  const friendIds = friendships.map(f => f.initiatorId === userId ? f.receiverId : f.initiatorId);
  if (!friendIds.length) return;

  await prisma.notification.createMany({
    data: friendIds.map(fid => ({
      userId: fid,
      type: 'NEW_FRIEND_REVIEW',
      payload: { reviewId, mediaTitle, fromUserId: userId },
    })),
  });
}

module.exports = router;
