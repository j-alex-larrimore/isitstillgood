// src/routes/lists.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

// Shared by every route below that needs to know if two users are friends —
// mirrors the same ACCEPTED-friendship check users.js's profile endpoint
// and media.js's reviewedBy gate already use.
async function areFriends(aId, bId) {
  if (!aId || !bId) return false;
  const friendship = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [{ initiatorId: aId, receiverId: bId }, { initiatorId: bId, receiverId: aId }],
    },
  });
  return !!friendship;
}

// A private list (isPublic:false) is visible to its owner and their
// accepted friends only — same "public unless you're a friend" model as a
// private profile. Distinct from ListShare below, which actively pushes a
// list to one specific friend regardless of this passive visibility.
async function canViewList(list, viewerId) {
  if (list.isPublic) return true;
  if (!viewerId) return false;
  if (viewerId === list.userId) return true;
  return areFriends(viewerId, list.userId);
}

// GET /api/lists/meta/shared-with-me — lists friends have actively shared
// with you (ListShare rows), most recent first. Registered ahead of
// GET /:username below with a two-segment literal path specifically so it
// can never collide with a real username there.
router.get('/meta/shared-with-me', requireAuth, async (req, res, next) => {
  try {
    const shares = await prisma.listShare.findMany({
      where: { recipientId: req.user.id },
      include: {
        list: { include: { user: { select: { username: true, displayName: true } }, _count: { select: { items: true } } } },
        sharedBy: { select: { username: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // A shared list's owner could later delete it — ListShare cascades on
    // that delete, so in practice this filter is defensive rather than
    // load-bearing, but skip any share whose list is gone rather than
    // letting one stale row 500 the whole response.
    res.json(shares.filter(s => s.list).map(s => ({
      listId: s.list.id,
      title: s.list.title,
      description: s.list.description,
      itemCount: s.list._count.items,
      owner: s.list.user,
      sharedBy: s.sharedBy,
      sharedAt: s.createdAt,
    })));
  } catch (err) { next(err); }
});

// GET /api/lists/:username  — lists visible to the viewer for a given user.
// profilePublic/private-account gating happens one level up (whether you
// can view the profile at all) — this is the list-level visibility within
// that: public lists always show, private ones only to the owner or an
// accepted friend.
router.get('/:username', optionalAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const isSelf = req.user?.id === user.id;
    const isFriend = !isSelf && await areFriends(req.user?.id, user.id);
    const lists = await prisma.mediaList.findMany({
      where: { userId: user.id, ...(!isSelf && !isFriend && { isPublic: true }) },
      include: { _count: { select: { items: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(lists);
  } catch (err) { next(err); }
});

// GET /api/lists/:listId/items — a single list's full contents. Two-segment
// path (id + literal "items") can't collide with the one-segment
// GET /:username above regardless of registration order.
router.get('/:listId/items', optionalAuth, async (req, res, next) => {
  try {
    const list = await prisma.mediaList.findUnique({
      where: { id: req.params.listId },
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!(await canViewList(list, req.user?.id))) {
      return res.status(403).json({ error: 'This list is private' });
    }

    const items = await prisma.listItem.findMany({
      where: { listId: list.id },
      include: {
        mediaItem: {
          select: {
            id: true, title: true, slug: true, mediaType: true, releaseYear: true,
            imageUrl: true, seriesName: true, seasonNumber: true, parentId: true,
          },
        },
      },
      orderBy: [{ position: 'asc' }, { addedAt: 'asc' }],
    });

    res.json({
      list: {
        id: list.id, title: list.title, description: list.description,
        isPublic: list.isPublic, createdAt: list.createdAt, owner: list.user,
      },
      isOwner: req.user?.id === list.userId,
      items,
    });
  } catch (err) { next(err); }
});

// POST /api/lists  — create a list
router.post('/', requireAuth, [
  body('title').trim().notEmpty().isLength({ max: 100 }),
  body('description').optional({ checkFalsy: true }).trim().isLength({ max: 500 }),
  body('isPublic').optional().isBoolean(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const list = await prisma.mediaList.create({
      data: {
        title: req.body.title,
        description: req.body.description || null,
        isPublic: req.body.isPublic !== undefined ? !!req.body.isPublic : true,
        userId: req.user.id,
      },
    });
    res.status(201).json(list);
  } catch (err) { next(err); }
});

// PATCH /api/lists/:listId — rename, redescribe, or toggle public/private
// (owner only)
router.patch('/:listId', requireAuth, [
  body('title').optional().trim().notEmpty().isLength({ max: 100 }),
  body('description').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 500 }),
  body('isPublic').optional().isBoolean(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const list = await prisma.mediaList.findUnique({ where: { id: req.params.listId } });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.user.id) return res.status(403).json({ error: 'Not your list' });
    const data = {};
    if (req.body.title !== undefined) data.title = req.body.title;
    if (req.body.description !== undefined) data.description = req.body.description || null;
    if (req.body.isPublic !== undefined) data.isPublic = !!req.body.isPublic;
    const updated = await prisma.mediaList.update({ where: { id: list.id }, data });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/lists/:listId — delete a whole list (owner only)
router.delete('/:listId', requireAuth, async (req, res, next) => {
  try {
    const list = await prisma.mediaList.findUnique({ where: { id: req.params.listId } });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.user.id) return res.status(403).json({ error: 'Not your list' });
    await prisma.mediaList.delete({ where: { id: list.id } });
    res.json({ message: 'List deleted' });
  } catch (err) { next(err); }
});

// POST /api/lists/:listId/items  — add media to list
router.post('/:listId/items', requireAuth, [
  body('mediaItemId').notEmpty(),
  body('note').optional({ checkFalsy: true }).trim().isLength({ max: 300 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const list = await prisma.mediaList.findUnique({ where: { id: req.params.listId } });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.user.id) return res.status(403).json({ error: 'Not your list' });
    const item = await prisma.listItem.create({
      data: { listId: req.params.listId, mediaItemId: req.body.mediaItemId, note: req.body.note || null },
    });
    res.status(201).json(item);
  } catch (err) {
    // @@unique([listId, mediaItemId]) — already on this list, not a real error
    if (err.code === 'P2002') return res.status(409).json({ error: 'Already on this list' });
    next(err);
  }
});

// DELETE /api/lists/:listId/items/:mediaItemId
router.delete('/:listId/items/:mediaItemId', requireAuth, async (req, res, next) => {
  try {
    const list = await prisma.mediaList.findUnique({ where: { id: req.params.listId } });
    if (!list || list.userId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    await prisma.listItem.delete({
      where: { listId_mediaItemId: { listId: req.params.listId, mediaItemId: req.params.mediaItemId } },
    });
    res.json({ message: 'Removed from list' });
  } catch (err) { next(err); }
});

// POST /api/lists/:listId/share — actively send this list to a specific
// friend ("Alex recommends this list to you"), distinct from just making a
// list visible via isPublic. Recipient must be an accepted friend — sharing
// is framed around your friend graph throughout this feature, not an
// arbitrary-user mechanism. Upserts so re-sharing with the same person
// refreshes the notification rather than erroring on the unique constraint.
router.post('/:listId/share', requireAuth, [
  body('recipientId').notEmpty(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const list = await prisma.mediaList.findUnique({ where: { id: req.params.listId } });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.user.id) return res.status(403).json({ error: 'Not your list' });
    if (req.body.recipientId === req.user.id) return res.status(400).json({ error: 'Cannot share with yourself' });
    if (!(await areFriends(req.user.id, req.body.recipientId))) {
      return res.status(403).json({ error: 'You can only share lists with friends' });
    }

    const share = await prisma.listShare.upsert({
      where: { listId_recipientId: { listId: list.id, recipientId: req.body.recipientId } },
      update: { createdAt: new Date() },
      create: { listId: list.id, sharedById: req.user.id, recipientId: req.body.recipientId },
    });

    await prisma.notification.create({
      data: {
        userId: req.body.recipientId,
        type: 'LIST_SHARED',
        payload: {
          fromUserId: req.user.id, fromUsername: req.user.username, fromDisplayName: req.user.displayName,
          listId: list.id, listTitle: list.title,
        },
      },
    }).catch(console.error);

    res.status(201).json(share);
  } catch (err) { next(err); }
});

module.exports = router;
