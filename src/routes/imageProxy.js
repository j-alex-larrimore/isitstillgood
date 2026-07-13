// src/routes/imageProxy.js
// Same-origin proxy for external cover-image CDNs — needed so the
// shareable tier-card feature (profile.html) can draw covers onto a
// <canvas> and export them. Confirmed live: TMDB, Google Books, and IGDB
// do NOT send Access-Control-Allow-Origin, so an <img crossOrigin
// ="anonymous"> pointed straight at those hosts taints the canvas and
// blocks toDataURL()/toBlob() with a SecurityError. Only Open Library
// sends permissive CORS — this proxy makes all four behave the same.
const router = require('express').Router();

// Exact-host allowlist — this must stay tight. Without it, this route is
// an open SSRF proxy that fetches any attacker-supplied URL through our
// server.
const ALLOWED_HOSTS = new Set([
  'image.tmdb.org',
  'books.google.com',
  'books.googleusercontent.com',
  'covers.openlibrary.org',
  'images.igdb.com',
]);

router.get('/', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: 'url is required' });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return res.status(400).json({ error: 'Host not allowed' });
  }

  try {
    const upstream = await fetch(target.toString());
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'Upstream fetch failed' });
    }
    res.set({
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: 'Upstream fetch failed' });
  }
});

module.exports = router;
