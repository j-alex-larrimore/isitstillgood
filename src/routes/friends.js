// src/routes/friends.js
const router = require('express').Router();
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { sendFriendRequestEmail, sendFriendAcceptedEmail } = require('../services/email');

// ─── GET /api/friends ─── My accepted friends ────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ initiatorId: req.user.id }, { receiverId: req.user.id }],
      },
      include: {
        // email included so the profile page's "exclude friend from
        // ratings" picker can resolve a chosen friend to their email —
        // excludedFriends stores email, not username, since username is
        // now user-editable (see PATCH /api/users/me/settings) and a
        // stored username would silently go stale on rename. Only ever
        // shown to a mutually-ACCEPTED friend, same trust boundary the
        // email-based friend search (GET /users/search) already uses.
        initiator: { select: { id: true, username: true, displayName: true, avatarUrl: true, email: true } },
        receiver:  { select: { id: true, username: true, displayName: true, avatarUrl: true, email: true } },
      },
    });

    const friends = friendships.map(f =>
      f.initiatorId === req.user.id ? f.receiver : f.initiator
    );

    res.json(friends);
  } catch (err) { next(err); }
});

// ─── GET /api/friends/requests ─── Incoming pending requests ────────────
router.get('/requests', requireAuth, async (req, res, next) => {
  try {
    const requests = await prisma.friendship.findMany({
      where: { receiverId: req.user.id, status: 'PENDING' },
      include: {
        initiator: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests);
  } catch (err) { next(err); }
});

// ─── POST /api/friends/request/:userId ─── Send a friend request ────────
router.post('/request/:userId', requireAuth, async (req, res, next) => {
  if (req.params.userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, email: true, displayName: true, emailOnFriendRequest: true },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Check for any existing relationship in either direction
    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { initiatorId: req.user.id, receiverId: req.params.userId },
          { initiatorId: req.params.userId, receiverId: req.user.id },
        ],
      },
    });

    if (existing) {
      if (existing.status === 'ACCEPTED') return res.status(409).json({ error: 'Already friends' });
      if (existing.status === 'PENDING')  return res.status(409).json({ error: 'Request already pending' });
      if (existing.status === 'BLOCKED')  return res.status(403).json({ error: 'Unable to send request' });
    }

    // @@unique([initiatorId, receiverId]) is directional, so it stops a
    // duplicate of THIS direction but not two people requesting each other in
    // the same instant — the existing-row check above can't see a row that
    // hasn't committed yet. P2002 covers the same-direction race cleanly; the
    // reciprocal one is healed at accept time, which deletes any other row for
    // the pair (see below), so a pair can never end up mutually "friends and
    // still pending".
    let friendship;
    try {
      friendship = await prisma.friendship.create({
        data: { initiatorId: req.user.id, receiverId: req.params.userId },
      });
    } catch (err) {
      if (err.code === 'P2002') return res.status(409).json({ error: 'Request already pending' });
      throw err;
    }

    // Notify the receiver
    await prisma.notification.create({
      data: {
        userId: req.params.userId,
        type: 'FRIEND_REQUEST',
        payload: { fromUserId: req.user.id, fromUsername: req.user.username, fromDisplayName: req.user.displayName },
      },
    }).catch(console.error);

    // Fire-and-forget, like the notification above — the request is already
    // saved, so a mail failure must not turn this into an error response.
    if (target.emailOnFriendRequest) {
      sendFriendRequestEmail({
        to: target.email,
        displayName: target.displayName,
        fromDisplayName: req.user.displayName,
        fromUsername: req.user.username,
      }).catch(console.error);
    }

    res.status(201).json(friendship);
  } catch (err) { next(err); }
});

// ─── POST /api/friends/accept/:friendshipId ──────────────────────────────
router.post('/accept/:friendshipId', requireAuth, async (req, res, next) => {
  try {
    const friendship = await prisma.friendship.findUnique({ where: { id: req.params.friendshipId } });
    if (!friendship) return res.status(404).json({ error: 'Request not found' });
    if (friendship.receiverId !== req.user.id) return res.status(403).json({ error: 'Not your request' });
    if (friendship.status !== 'PENDING') return res.status(400).json({ error: 'Request is not pending' });

    const updated = await prisma.friendship.update({
      where: { id: req.params.friendshipId },
      data: { status: 'ACCEPTED' },
    });

    // Drop any other row for this pair — the reciprocal request that a
    // simultaneous "add" race can leave behind (see the P2002 note above).
    // Without this, accepting one would leave the other still PENDING, so the
    // pair would show as friends while one of them still had a live request.
    await prisma.friendship.deleteMany({
      where: {
        id: { not: updated.id },
        OR: [
          { initiatorId: friendship.initiatorId, receiverId: friendship.receiverId },
          { initiatorId: friendship.receiverId,  receiverId: friendship.initiatorId },
        ],
      },
    }).catch(console.error);

    res.json(updated);

    // Accepting used to tell the requester nothing at all — no notification,
    // no email — so the person who made the first move never learned it had
    // worked. Both are fire-and-forget: the friendship is already committed
    // and the response has been sent.
    const initiator = await prisma.user.findUnique({
      where: { id: friendship.initiatorId },
      select: { email: true, displayName: true, emailOnFriendRequest: true },
    }).catch(() => null);
    if (!initiator) return;

    prisma.notification.create({
      data: {
        userId: friendship.initiatorId,
        type: 'FRIEND_ACCEPTED',
        payload: {
          fromUserId: req.user.id,
          fromUsername: req.user.username,
          fromDisplayName: req.user.displayName,
        },
      },
    }).catch(console.error);

    if (initiator.emailOnFriendRequest) {
      sendFriendAcceptedEmail({
        to: initiator.email,
        displayName: initiator.displayName,
        friendDisplayName: req.user.displayName,
        friendUsername: req.user.username,
      }).catch(console.error);
    }
  } catch (err) { next(err); }
});

// ─── DELETE /api/friends/decline/:friendshipId ───────────────────────────
router.delete('/decline/:friendshipId', requireAuth, async (req, res, next) => {
  try {
    const friendship = await prisma.friendship.findUnique({ where: { id: req.params.friendshipId } });
    if (!friendship) return res.status(404).json({ error: 'Not found' });
    if (friendship.receiverId !== req.user.id && friendship.initiatorId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    await prisma.friendship.delete({ where: { id: req.params.friendshipId } });
    res.json({ message: 'Request declined / friend removed' });
  } catch (err) { next(err); }
});

// ─── POST /api/friends/block/:userId ─────────────────────────────────────
// Blocking replaces whatever relationship existed — an accepted friendship, a
// request in either direction — with a single BLOCKED row owned by the
// blocker. POST /request/:userId then refuses either direction of a new
// request for as long as that row stands (see the BLOCKED branch above).
router.post('/block/:userId', requireAuth, async (req, res, next) => {
  if (req.params.userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot block yourself' });
  }
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.userId }, select: { id: true },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Clearing first makes this idempotent: re-blocking someone already
    // blocked replaces the row rather than colliding with the unique index.
    await prisma.friendship.deleteMany({
      where: {
        OR: [
          { initiatorId: req.user.id, receiverId: req.params.userId },
          { initiatorId: req.params.userId, receiverId: req.user.id },
        ],
      },
    });
    const blocked = await prisma.friendship.create({
      data: { initiatorId: req.user.id, receiverId: req.params.userId, status: 'BLOCKED' },
    });
    res.json(blocked);
  } catch (err) { next(err); }
});

// ─── DELETE /api/friends/block/:userId ─── Unblock ───────────────────────
// Only removes a block THIS user owns. Deleting by the pair rather than by
// friendship id keeps a block the other person placed out of reach, which
// matching on either direction would have exposed.
router.delete('/block/:userId', requireAuth, async (req, res, next) => {
  try {
    const result = await prisma.friendship.deleteMany({
      where: { initiatorId: req.user.id, receiverId: req.params.userId, status: 'BLOCKED' },
    });
    if (!result.count) return res.status(404).json({ error: 'Not blocked' });
    res.json({ message: 'Unblocked' });
  } catch (err) { next(err); }
});

// ─── GET /api/friends/blocked ─── Who I've blocked ───────────────────────
// Only blocks this user placed. Someone who blocked you is deliberately not
// listed — that would turn the block into a notification.
router.get('/blocked', requireAuth, async (req, res, next) => {
  try {
    const rows = await prisma.friendship.findMany({
      where: { initiatorId: req.user.id, status: 'BLOCKED' },
      include: {
        receiver: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(rows.map(r => r.receiver));
  } catch (err) { next(err); }
});

// ─── GET /api/friends/requests/sent ─── Outgoing pending requests ────────
// The counterpart to /requests above. Without it the only way to see you'd
// already asked someone was to search for them again one at a time.
router.get('/requests/sent', requireAuth, async (req, res, next) => {
  try {
    const requests = await prisma.friendship.findMany({
      where: { initiatorId: req.user.id, status: 'PENDING' },
      include: {
        receiver: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests);
  } catch (err) { next(err); }
});

// ─── GET /api/friends/status/:userId ─────────────────────────────────────
router.get('/status/:userId', requireAuth, async (req, res, next) => {
  try {
    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { initiatorId: req.user.id, receiverId: req.params.userId },
          { initiatorId: req.params.userId, receiverId: req.user.id },
        ],
      },
    });
    res.json({
      status: friendship?.status || 'NONE',
      direction: friendship
        ? (friendship.initiatorId === req.user.id ? 'SENT' : 'RECEIVED')
        : null,
      friendshipId: friendship?.id || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
