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

// GET /api/lists/:username  — all public lists for a user
router.get('/:username', optionalAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const isSelf = req.user?.id === user.id;
    const lists = await prisma.mediaList.findMany({
      where: { userId: user.id, ...(!isSelf && { isPublic: true }) },
      include: { _count: { select: { items: true } } },
    });
    res.json(lists);
  } catch (err) { next(err); }
});

// POST /api/lists  — create a list
router.post('/', requireAuth, [
  body('title').trim().notEmpty().isLength({ max: 100 }),
  body('description').optional().trim(),
  body('isPublic').optional().isBoolean(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const list = await prisma.mediaList.create({
      data: { ...req.body, userId: req.user.id },
    });
    res.status(201).json(list);
  } catch (err) { next(err); }
});

// POST /api/lists/:listId/items  — add media to list
router.post('/:listId/items', requireAuth, [
  body('mediaItemId').notEmpty(),
  body('note').optional().trim().isLength({ max: 300 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const list = await prisma.mediaList.findUnique({ where: { id: req.params.listId } });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.user.id) return res.status(403).json({ error: 'Not your list' });
    const item = await prisma.listItem.create({
      data: { listId: req.params.listId, mediaItemId: req.body.mediaItemId, note: req.body.note },
    });
    res.status(201).json(item);
  } catch (err) { next(err); }
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

module.exports = router;
