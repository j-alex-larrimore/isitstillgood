const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router  = express.Router();
const prisma  = new PrismaClient();
const BASE    = 'https://www.isitstillgood.com';

// ─── GET /sitemap.xml ─────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    // Fetch all public-facing media items — exclude TV seasons (parentId not null)
    // since they're accessed via the parent show page
    const items = await prisma.mediaItem.findMany({
      where: { parentId: null },
      select: { slug: true, updatedAt: true, mediaType: true },
      orderBy: { updatedAt: 'desc' },
    });

    const staticPages = [
      { url: '/',             changefreq: 'daily',   priority: '1.0' },
      { url: '/browse.html',  changefreq: 'daily',   priority: '0.8' },
      { url: '/search.html',  changefreq: 'monthly', priority: '0.5' },
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
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
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
