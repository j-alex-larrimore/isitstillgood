const express  = require('express');
const { body, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');
const { sendNewMessageEmail } = require('../services/email');

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

    // Look up recipient and review in parallel. email/emailOnMessage are
    // fetched here (for the notification email below) but deliberately kept
    // OUT of USER_SELECT — that shape gets echoed straight back to the
    // sender via the created message's `include` further down, and a
    // recipient's email/notification preference has no business reaching
    // whoever's messaging them.
    const [recipient, review] = await Promise.all([
      prisma.user.findUnique({
        where: { username: recipientUsername },
        select: { ...USER_SELECT, email: true, emailOnMessage: true },
      }),
      reviewId ? prisma.review.findUnique({
        where: { id: reviewId },
        select: { id: true, mediaItem: { select: { title: true, slug: true } } },
      }) : Promise.resolve(null),
    ]);

    if (!recipient) return res.status(404).json({ error: 'User not found' });
    if (reviewId && !review) return res.status(404).json({ error: 'Review not found' });

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

    // Respond immediately — notification is fire-and-forget
    res.status(201).json(message);

    prisma.notification.create({
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

    // emailOnMessage defaults to true (see the schema comment) — messaging
    // has no other nudge like a friend request's notification-bell badge,
    // so this is opt-out rather than opt-in. Fire-and-forget, same as the
    // in-app notification above — a delivery failure here shouldn't affect
    // the message itself, which already sent successfully.
    if (recipient.emailOnMessage) {
      sendNewMessageEmail({
        to: recipient.email,
        displayName: recipient.displayName,
        fromDisplayName: req.user.displayName,
        fromUsername: req.user.username,
        preview: msgBody.slice(0, 80),
      }).catch(console.error);
    }

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
