// src/routes/admin.js
const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const prisma  = require('../lib/prisma');
const { requireAdmin } = require('../middleware/admin');
const { fetchExternalRatings } = require('../services/externalRatings');

function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

function slugify(title, year) {
  const base = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
  return year ? `${base}-${year}` : base;
}

async function uniqueSlug(base) {
  let slug = base, i = 1;
  while (await prisma.mediaItem.findUnique({ where: { slug } })) slug = `${base}-${i++}`;
  return slug;
}

async function connectPersons(names) {
  if (!names?.length) return undefined;
  const persons = await Promise.all(names.map(name => {
    const personSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return prisma.person.upsert({
      where: { slug: personSlug },
      update: { name },
      create: { name, slug: personSlug },
    });
  }));
  return { connect: persons.map(p => ({ id: p.id })) };
}

// ─── GET /api/admin/stats ─────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const [users, mediaItems, reviews, pendingRequests] = await Promise.all([
      prisma.user.count(),
      prisma.mediaItem.count(),
      prisma.review.count(),
      prisma.mediaRequest.count({ where: { resolved: false, flagged: false } }),
    ]);
    res.json({ users, mediaItems, reviews, pendingRequests });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/requests ──────────────────────────────────────────────
router.get('/requests', requireAdmin, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = 50;
    const resolved = req.query.resolved === 'true';
    const [requests, total] = await Promise.all([
      prisma.mediaRequest.findMany({
        where: { resolved },
        include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
        orderBy: [{ requestCount: 'desc' }, { createdAt: 'asc' }],
        skip: (page - 1) * take, take,
      }),
      prisma.mediaRequest.count({ where: { resolved } }),
    ]);
    res.json({ requests, total, page, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/requests/:id/flag ──────────────────────────────────
router.patch('/requests/:id/flag', requireAdmin, [
  body('flagNote').trim().isLength({ min: 1, max: 500 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const request = await prisma.mediaRequest.update({
      where: { id: req.params.id },
      data: { flagged: true, flagNote: req.body.flagNote },
    });
    await prisma.notification.create({
      data: {
        userId: request.userId, type: 'REQUEST_FLAGGED',
        payload: { requestId: request.id, title: request.title, flagNote: req.body.flagNote },
      },
    }).catch(console.error);
    res.json(request);
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/requests/:id/resolve ───────────────────────────────
router.patch('/requests/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const request = await prisma.mediaRequest.update({ where: { id: req.params.id }, data: { resolved: true } });
    res.json(request);
  } catch (err) { next(err); }
});

// ─── DELETE /api/admin/requests/:id ──────────────────────────────────────
router.delete('/requests/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.mediaRequest.delete({ where: { id: req.params.id } });
    res.json({ message: 'Request deleted' });
  } catch (err) { next(err); }
});

// ─── POST /api/admin/media ─── Add a media item ───────────────────────────
router.post('/media', requireAdmin, [
  body('mediaType').isIn(['MOVIE', 'BOOK', 'TV_SHOW', 'VIDEO_GAME']),
  body('title').trim().notEmpty(),
  body('releaseYear').optional({ nullable: true }).isInt({ min: 1800, max: 2200 }),
  body('description').optional().trim(),
  body('imageUrl').optional({ nullable: true }),
  body('genres').optional().isArray(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const {
      mediaType, title, releaseYear, description, imageUrl, genres,
      imdbId, goodreadsId, openCriticId,
      // Movie
      directorNames, castNames, mpaaRating,
      // TV Show
      seasons, seasonCount,
      // Book
      authorNames, seriesName, seriesNumber,
      // Video Game
      openCriticId: ocId,
    } = req.body;

    const slug = await uniqueSlug(slugify(title, releaseYear));

    const item = await prisma.mediaItem.create({
      data: {
        mediaType, title, slug,
        releaseYear: releaseYear ? parseInt(releaseYear) : null,
        description: description || null,
        imageUrl: imageUrl || null,
        genres: genres || [],
        imdbId: imdbId || null,
        goodreadsId: goodreadsId || null,
        openCriticId: openCriticId || ocId || null,
        // Movie fields
        mpaaRating: mpaaRating || null,
        // TV fields
        seasons: seasons ? parseInt(seasons) : (seasonCount ? parseInt(seasonCount) : null),
        // Book fields
        seriesName: seriesName || null,
        seriesNumber: seriesNumber ? parseInt(seriesNumber) : null,
        // Relations
        directors: await connectPersons(directorNames),
        cast:      await connectPersons(castNames),
        authors:   await connectPersons(authorNames),
      },
      include: { directors: true, cast: true, authors: true },
    });

    if (imdbId || goodreadsId || openCriticId) {
      fetchExternalRatings(item.id).catch(console.error);
    }

    res.status(201).json(item);
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/media/:id ───────────────────────────────────────────
router.patch('/media/:id', requireAdmin, async (req, res, next) => {
  try {
    const allowed = [
      'title','description','imageUrl','genres','releaseYear',
      'imdbId','imdbRating','rtScore','rtAudienceScore',
      'goodreadsId','goodreadsRating','openCriticId','openCriticScore',
      'metacriticScore','mpaaRating','seasons',
      'seriesName','seriesNumber',
    ];
    const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const item = await prisma.mediaItem.update({ where: { id: req.params.id }, data });
    res.json(item);
  } catch (err) { next(err); }
});

// ─── DELETE /api/admin/media/:id ──────────────────────────────────────────
router.delete('/media/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.mediaItem.delete({ where: { id: req.params.id } });
    res.json({ message: 'Media item deleted' });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/settings ──────────────────────────────────────────────
router.get('/settings', requireAdmin, async (req, res, next) => {
  try {
    const settings = await prisma.adminSetting.findMany();
    res.json(Object.fromEntries(settings.map(s => [s.key, s.value])));
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/settings ────────────────────────────────────────────
router.patch('/settings', requireAdmin, async (req, res, next) => {
  try {
    const { feedTimeframeDays } = req.body;
    if (feedTimeframeDays !== undefined) {
      await prisma.adminSetting.upsert({
        where: { key: 'feedTimeframeDays' },
        update: { value: String(feedTimeframeDays) },
        create: { key: 'feedTimeframeDays', value: String(feedTimeframeDays) },
      });
    }
    res.json({ message: 'Settings updated' });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = 30;
    const where = req.query.q ? {
      OR: [
        { username:    { contains: req.query.q, mode: 'insensitive' } },
        { displayName: { contains: req.query.q, mode: 'insensitive' } },
        { email:       { contains: req.query.q, mode: 'insensitive' } },
      ],
    } : {};
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, username: true, displayName: true, email: true, avatarUrl: true, isAdmin: true, createdAt: true, _count: { select: { reviews: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take, take,
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total, page, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

module.exports = router;
