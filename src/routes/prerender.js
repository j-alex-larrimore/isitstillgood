// Pre-rendering for search engine crawlers
// Serves a complete static HTML page to Googlebot and other crawlers
// so they see real content instead of an empty JS shell

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router  = express.Router();
const prisma  = new PrismaClient();

const BASE = 'https://www.isitstillgood.com';

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function ratingToVerdict(r) {
  if (r >= 9) return '★ Timeless';
  if (r >= 7) return '✓ Still Good';
  if (r >= 4) return '~ Mixed';
  return '✗ Not Good';
}

// ─── GET /render/item/:slug ───────────────────────────────────────────────────
router.get('/item/:slug', async (req, res, next) => {
  try {
    const item = await prisma.mediaItem.findUnique({
      where: { slug: req.params.slug },
      include: {
        directors: { select: { name: true }, take: 10 },
        authors:   { select: { name: true }, take: 10 },
        cast:      { select: { name: true }, take: 10 },
        _count:    { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
      },
    });

    if (!item) return res.status(404).send('<h1>Not Found</h1>');

    // Community stats
    const stats = await prisma.review.aggregate({
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      _avg: { rating: true },
      _count: { rating: true },
    });

    // Recent public reviews
    const reviews = await prisma.review.findMany({
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      include: { user: { select: { displayName: true, username: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });

    const avg = stats._avg.rating;
    const count = stats._count.rating;
    const typeLabel = { MOVIE:'Movie', BOOK:'Book', TV_SHOW:'TV Show', VIDEO_GAME:'Video Game' }[item.mediaType] || '';
    const title = item.title;
    const year = item.releaseYear ? ` (${item.releaseYear})` : '';
    const desc = avg
      ? `Rated ${avg.toFixed(1)}/10 from ${count} review${count !== 1 ? 's' : ''}. Is ${title} still worth your time? Read community reviews on IsItStillGood.com.`
      : `Is ${title} still worth your time? Be the first to review it on IsItStillGood.com.`;

    const people = [
      ...(item.directors || []).map(d => d.name),
      ...(item.authors   || []).map(a => a.name),
    ].slice(0, 3).join(', ');

    const castList = (item.cast || []).slice(0, 8).map(c => c.name).join(', ');

    const reviewsHtml = reviews.map(r => `
      <div style="border-bottom:1px solid #ddd;padding:12px 0">
        <strong>${esc(r.user.displayName)}</strong> rated it <strong>${r.rating}/10</strong> — ${ratingToVerdict(r.rating)}
        ${r.reviewText ? `<p style="margin:6px 0 0;color:#333">${esc(r.reviewText.slice(0, 300))}${r.reviewText.length > 300 ? '…' : ''}</p>` : ''}
      </div>`).join('');

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': { MOVIE:'Movie', TV_SHOW:'TVSeries', BOOK:'Book', VIDEO_GAME:'VideoGame' }[item.mediaType] || 'CreativeWork',
      name: title,
      url: `${BASE}/item.html?slug=${item.slug}`,
      ...(item.releaseYear  && { datePublished: String(item.releaseYear) }),
      ...(item.description  && { description: item.description.slice(0, 300) }),
      ...(item.imageUrl     && { image: item.imageUrl }),
      ...(item.genres?.length && { genre: item.genres }),
      ...(item.directors?.length && { director: item.directors.map(d => ({ '@type':'Person', name: d.name })) }),
      ...(item.authors?.length   && { author:   item.authors.map(a => ({ '@type':'Person', name: a.name })) }),
      ...(avg && count >= 1 && { aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: avg.toFixed(1),
        bestRating: '10', worstRating: '1',
        ratingCount: count,
      }}),
    };

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}${esc(year)} — Is It (Still) Good?</title>
  <meta name="description" content="${esc(desc)}">
  <meta property="og:title" content="${esc(title)}${esc(year)} — Is It (Still) Good?">
  <meta property="og:description" content="${esc(desc)}">
  ${item.imageUrl ? `<meta property="og:image" content="${esc(item.imageUrl)}">` : ''}
  <link rel="canonical" href="${BASE}/item.html?slug=${esc(item.slug)}">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1C1710; }
    h1 { font-size: 2em; margin-bottom: 4px; }
    .meta { color: #7A6E5A; font-size: 0.9em; margin-bottom: 16px; }
    .rating { font-size: 1.4em; font-weight: bold; color: #C8832A; margin-bottom: 8px; }
    .desc { line-height: 1.6; margin-bottom: 20px; }
    .back { display: inline-block; margin-bottom: 20px; color: #C8832A; text-decoration: none; }
  </style>
</head>
<body>
  <a href="${BASE}" class="back">← IsItStillGood.com</a>
  ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(title)}" style="float:right;max-width:180px;margin:0 0 16px 16px;border-radius:8px">` : ''}
  <h1>${esc(title)}${esc(year)}</h1>
  <div class="meta">
    ${esc(typeLabel)}
    ${item.genres?.length ? ` · ${item.genres.slice(0,3).map(esc).join(', ')}` : ''}
    ${people ? ` · ${esc(people)}` : ''}
  </div>
  ${avg ? `<div class="rating">${avg.toFixed(1)}/10 — ${ratingToVerdict(avg)} · ${count} review${count !== 1 ? 's' : ''}</div>` : '<div class="meta">No reviews yet</div>'}
  ${item.description ? `<div class="desc">${esc(item.description)}</div>` : ''}
  ${castList ? `<p><strong>Cast:</strong> ${esc(castList)}</p>` : ''}
  <hr>
  <h2>Community Reviews</h2>
  ${reviewsHtml || '<p>No reviews yet — be the first!</p>'}
  <p style="margin-top:24px"><a href="${BASE}/item.html?slug=${esc(item.slug)}" style="color:#C8832A">See full page with ratings &amp; more →</a></p>
</body>
</html>`);
  } catch (err) { next(err); }
});

module.exports = router;
