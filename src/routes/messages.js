const express  = require('express');
const { body, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

const USER_SELECT = {
  id: true, username: true, displayName: true, avatarUrl: true,
};

// ─── POST /api/messages ── Send a message ────────────────────────────────────
router.post('/', requireAuth, [
  body('recipientUsername').trim().notEmpty(),
  body('body').trim().isLength({ min: 1, max: 2000 }),
  body('reviewId').optional({ nullable: true }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { recipientUsername, body: msgBody, reviewId } = req.body;

    if (recipientUsername === req.user.username)
      return res.status(400).json({ error: "You can't message yourself" });

    const recipient = await prisma.user.findUnique({
      where: { username: recipientUsername },
      select: USER_SELECT,
    });
    if (!recipient) return res.status(404).json({ error: 'User not found' });

    // Validate reviewId if provided
    let review = null;
    if (reviewId) {
      review = await prisma.review.findUnique({
        where: { id: reviewId },
        select: { id: true, mediaItem: { select: { title: true, slug: true } } },
      });
      if (!review) return res.status(404).json({ error: 'Review not found' });
    }

    const message = await prisma.message.create({
      data: {
        senderId:    req.user.id,
        recipientId: recipient.id,
        body:        msgBody,
        reviewId:    reviewId || null,
      },
      include: {
        sender:    { select: USER_SELECT },
        recipient: { select: USER_SELECT },
        review:    { select: { id: true, mediaItem: { select: { title: true, slug: true } } } },
      },
    });

    // Notify recipient
    await prisma.notification.create({
      data: {
        userId:  recipient.id,
        type:    'NEW_MESSAGE',
        payload: {
          fromUsername:    req.user.username,
          fromDisplayName: req.user.displayName,
          preview:         msgBody.slice(0, 80),
          reviewContext:   review?.mediaItem?.title || null,
        },
      },
    }).catch(console.error);

    res.status(201).json(message);
  } catch (err) { next(err); }
});

// ─── GET /api/messages ── Inbox: list conversations ──────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    // Get all messages involving this user, then group by conversation partner
    const messages = await prisma.message.findMany({
      where: {
        OR: [{ senderId: req.user.id }, { recipientId: req.user.id }],
      },
      include: {
        sender:    { select: USER_SELECT },
        recipient: { select: USER_SELECT },
        review:    { select: { id: true, mediaItem: { select: { title: true, slug: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group by conversation partner, keeping latest message per convo
    const convos = {};
    for (const msg of messages) {
      const partnerId = msg.senderId === req.user.id ? msg.recipientId : msg.senderId;
      const partner   = msg.senderId === req.user.id ? msg.recipient   : msg.sender;
      if (!convos[partnerId]) {
        convos[partnerId] = {
          partner,
          latestMessage: msg,
          unreadCount: 0,
        };
      }
      // Count unread messages FROM partner TO me
      if (msg.recipientId === req.user.id && !msg.read) {
        convos[partnerId].unreadCount++;
      }
    }

    res.json({
      conversations: Object.values(convos),
      totalUnread: Object.values(convos).reduce((sum, c) => sum + c.unreadCount, 0),
    });
  } catch (err) { next(err); }
});

// ─── GET /api/messages/:username ── Thread with a specific user ───────────────
router.get('/:username', requireAuth, async (req, res, next) => {
  try {
    const other = await prisma.user.findUnique({
      where: { username: req.params.username },
      select: USER_SELECT,
    });
    if (!other) return res.status(404).json({ error: 'User not found' });

    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: req.user.id,  recipientId: other.id },
          { senderId: other.id,     recipientId: req.user.id },
        ],
      },
      include: {
        sender:    { select: USER_SELECT },
        recipient: { select: USER_SELECT },
        review:    { select: { id: true, mediaItem: { select: { title: true, slug: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Mark all unread messages from other user as read
    await prisma.message.updateMany({
      where: { senderId: other.id, recipientId: req.user.id, read: false },
      data:  { read: true },
    });

    res.json({ messages, partner: other });
  } catch (err) { next(err); }
});

// ─── GET /api/messages/unread/count ── Unread count for badge ────────────────
router.get('/unread/count', requireAuth, async (req, res, next) => {
  try {
    const count = await prisma.message.count({
      where: { recipientId: req.user.id, read: false },
    });
    res.json({ count });
  } catch (err) { next(err); }
});

module.exports = router;
