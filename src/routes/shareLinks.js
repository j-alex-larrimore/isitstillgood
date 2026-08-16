// src/routes/shareLinks.js
// Short codes for Share-a-Snapshot links — see the ShareLink model comment
// in prisma/schema.prisma. Mounted twice in app.js: this router's '/'
// (POST, mint) and '/:code' (GET, resolve) live under /api/share-links.
const router = require('express').Router();
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

// Excludes visually ambiguous characters (0/O, 1/l/I) since a code is
// sometimes read aloud or retyped, not just tapped as a link.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
function generateCode(length = 7) {
  return Array.from(crypto.randomBytes(length), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// POST /api/share-links — mint a short code for a browse.html/profile.html
// share-card link. Requires auth (Share a Snapshot itself already does)
// partly as a light anti-abuse gate, and path is restricted to same-site
// browse.html/profile.html query strings — this must never be usable as an
// open redirect to an arbitrary external URL.
router.post('/', requireAuth, async (req, res, next) => {
  const { path } = req.body;
  if (typeof path !== 'string' || !/^\/(browse|profile)\.html\?/.test(path)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        await prisma.shareLink.create({ data: { code, path } });
        return res.status(201).json({ code });
      } catch (err) {
        if (err.code === 'P2002') continue; // extremely rare code collision — retry with a fresh one
        throw err;
      }
    }
    res.status(500).json({ error: 'Could not generate a unique code' });
  } catch (err) { next(err); }
});

// GET /api/share-links/:code — resolve a code back to its full path+query.
// No auth required — the whole point is a friend who isn't logged in yet
// (or isn't a friend at all) can still open the link; browse.html/
// profile.html's own privacy gate (see media.js's reviewedBy handling)
// takes over from here.
router.get('/:code', async (req, res, next) => {
  try {
    const link = await prisma.shareLink.findUnique({ where: { code: req.params.code } });
    if (!link) return res.status(404).json({ error: 'Link not found' });
    res.json({ path: link.path });
  } catch (err) { next(err); }
});

module.exports = router;
