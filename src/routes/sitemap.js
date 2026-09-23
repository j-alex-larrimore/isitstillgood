const express = require('express');
const prisma  = require('../lib/prisma');

const router  = express.Router();
const BASE    = 'https://www.isitstillgood.com';

// ─── GET /sitemap.xml ─────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    // Public-facing media items. TV seasons (parentId not null) are excluded —
    // they're reached via the parent show, and a reviewless one is noindexed
    // anyway (see prerender.js).
    //
    // A page also has to have something ON it. Requiring a description and a
    // cover drops the rows that are a bare title and nothing else, which are
    // exactly the pages Google fetches and files under "crawled, currently not
    // indexed".
    //
    // Deliberately NOT filtered on tmdbRating / streamingProviders /
    // openCriticScore, even though those look like better quality signals.
    // Measured across the catalogue, they track which media type has that
    // column populated rather than whether a title is any good: filtering on
    // them keeps 99% of movies and 5% of books, because books have no external
    // rating field in this schema at all. That would cut ~5.2K sound book
    // pages for a reason that has nothing to do with their content.
    //
    // A real popularity threshold needs a vote/rating COUNT, which isn't
    // stored yet — only the scores themselves, and an 8.0 from five votes is
    // indistinguishable from an 8.0 from fifty thousand. TMDB's vote_count and
    // IGDB's rating_count are both already read during sync (that's where the
    // sweep thresholds came from), so persisting them is what would unlock a
    // genuine notability cut here.
    const items = await prisma.mediaItem.findMany({
      where: {
        parentId: null,
        verified: true,
        description: { not: null },
        imageUrl:    { not: null },
      },
      select: { slug: true, updatedAt: true, mediaType: true, _count: { select: { reviews: true } } },
      orderBy: { updatedAt: 'desc' },
    });

    // search.html carries noindex,follow — listing a page in a sitemap while
    // telling Google not to index it is a contradiction Search Console reports.
    const staticPages = [
      { url: '/',             changefreq: 'daily',   priority: '1.0' },
      { url: '/browse.html',  changefreq: 'daily',   priority: '0.8' },
    ];

    const urlEntries = [
      // Static pages
      ...staticPages.map(p => `
  <url>
    <loc>${BASE}${p.url}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`),

      // Item pages
      ...items.map(item => `
  <url>
    <loc>${BASE}/item.html?slug=${item.slug}</loc>
    <lastmod>${item.updatedAt.toISOString().split('T')[0]}</lastmod>
    <changefreq>${item._count.reviews > 0 ? 'weekly' : 'monthly'}</changefreq>
    <priority>${item._count.reviews > 0 ? '0.8' : '0.6'}</priority>
  </url>`),
    ].join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // cache 1 hour
    res.send(xml);
  } catch (err) { next(err); }
});

module.exports = router;
