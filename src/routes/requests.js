// src/routes/requests.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

// ─── POST /api/requests ─── Submit a title request ───────────────────────
router.post('/', requireAuth, [
  body('title').trim().notEmpty().isLength({ max: 200 }),
  body('mediaType').isIn(['MOVIE', 'BOOK', 'TV_SHOW', 'VIDEO_GAME']),
  body('directorOrAuthor').optional().trim().isLength({ max: 200 }),
  body('notes').optional().trim().isLength({ max: 500 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  const { title, mediaType, directorOrAuthor, notes } = req.body;

  try {
    // Check if a very similar request already exists (case-insensitive title match)
    const existing = await prisma.mediaRequest.findFirst({
      where: {
        title: { equals: title, mode: 'insensitive' },
        mediaType,
        resolved: false,
      },
    });

    if (existing) {
      // Increment the request count instead of creating a duplicate
      const updated = await prisma.mediaRequest.update({
        where: { id: existing.id },
        data: { requestCount: { increment: 1 } },
      });
      return res.status(200).json({ ...updated, merged: true });
    }

    const request = await prisma.mediaRequest.create({
      data: {
        userId: req.user.id,
        title,
        mediaType,
        directorOrAuthor,
        notes,
      },
    });

    res.status(201).json(request);
  } catch (err) { next(err); }
});

// ─── GET /api/requests/my ─── My own requests + their status ─────────────
router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const requests = await prisma.mediaRequest.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests);
  } catch (err) { next(err); }
});

module.exports = router;
