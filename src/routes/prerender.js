// Pre-rendering for search engine crawlers
// Serves a complete static HTML page to Googlebot and other crawlers
// so they see real content instead of an empty JS shell

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { sortByCastOrder } = require('../lib/mediaHelpers');
const router  = express.Router();
const prisma  = new PrismaClient();

const BASE = 'https://www.isitstillgood.com';

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function ratingToVerdict(r) {
  const words = {
    10: 'Perfect', 9: 'Excellent', 8: 'Great', 7: 'Good', 6: 'Solid',
    5: 'Fine', 4: 'Mediocre', 3: 'Bad', 2: 'Awful', 1: 'The Worst',
  };
  const rounded = Math.round(r);
  const icon = rounded >= 9 ? '★' : rounded >= 6 ? '✓' : rounded >= 4 ? '~' : '✗';
  return `${icon} ${words[rounded] || 'Unrated'}`;
}

// ─── GET /render/item/:slug ───────────────────────────────────────────────────
router.get('/item/:slug', async (req, res, next) => {
  try {
    const item = await prisma.mediaItem.findUnique({
      where: { slug: req.params.slug },
      include: {
        directors: { select: { name: true }, take: 10 },
        authors:   { select: { name: true }, take: 10 },
        cast:      { select: { id: true, name: true }, take: 10 },
        _count:    { select: { reviews: { where: { visibility: 'PUBLIC' } } } },
        // For seasons: a season row's own `cast` is only its season-specific
        // guest stars — the recurring ensemble lives on the parent show's
        // cast instead. Same split media.js's /:slug route already merges
        // for the real page; without it here, bots/crawlers saw only the
        // guest list (e.g. one season of Parks and Rec showed "Paul Rudd,
        // Kathryn Hahn" — that season's guests — with the actual regular
        // cast missing entirely). See the merge below.
        parent: { include: { cast: { select: { id: true, name: true }, take: 10 } } },
      },
    });

    if (!item || !item.verified) return res.status(404).send('<h1>Not Found</h1>');

    // Same merge media.js's GET /:slug does: season's own cast (guest stars)
    // plus whichever parent-show regulars aren't already covered, minus
    // anyone in excludedCast (departed actors) — matched by name since a
    // Person's id can differ between how it's connected on the season vs.
    // the parent. Each half sorted into its OWN billing order before
    // merging (see sortByCastOrder) — a prerendered page that showed cast
    // in a different order than the real page would be cloaking, not just
    // a cosmetic gap.
    if (item.parentId && item.parent?.cast?.length) {
      const seasonCastIds  = new Set((item.cast || []).map(p => p.id));
      const excluded       = new Set((item.excludedCast || []).map(n => n.toLowerCase()));
      const parentOnlyCast = sortByCastOrder(item.parent.cast, item.parent.castOrder).filter(p =>
        !seasonCastIds.has(p.id) && !excluded.has(p.name.toLowerCase())
      );
      item.cast = [...sortByCastOrder(item.cast, item.castOrder), ...parentOnlyCast];
    } else {
      item.cast = sortByCastOrder(item.cast, item.castOrder);
    }
    if (item.excludedCast?.length) {
      const excluded = new Set(item.excludedCast.map(n => n.toLowerCase()));
      item.cast = (item.cast || []).filter(p => !excluded.has(p.name.toLowerCase()));
    }

    // Community stats
    const stats = await prisma.review.aggregate({
      where: { mediaItemId: item.id, visibility: 'PUBLIC' },
      _avg: { rating: true },
      _count: { rating: true },
    });

    // Recent public reviews, by authors whose profiles are public.
    //
    // This route has no viewer — it renders for crawlers — so the
    // "or it's yours, or a friend's" half of the rule that feed.js and
    // media.js apply has nothing to match on here: public is the only case
    // that can qualify. Without the profilePublic clause a private profile's
    // writing was still being served to Googlebot under the author's name,
    // which is the most durable version of exactly the exposure the API-side
    // filters exist to prevent.
    const reviews = await prisma.review.findMany({
      where: {
        mediaItemId: item.id,
        visibility: 'PUBLIC',
        user: { profilePublic: true },
      },
      include: { user: { select: { displayName: true, username: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });

    const avg = stats._avg.rating;
    const count = stats._count.rating;
    // TV seasons of the same show share almost all their content (cast,
    // genre, a synced-from-TMDB description) — the only thing unique to any
    // one season's page is its own reviews. With none yet, that page is a
    // near-duplicate of its siblings and Google was already declining to
    // index most of them (confirmed live via Search Console). noindex,follow
    // tells it not to bother while still letting it follow the links here
    // (cast, "all seasons") — this stops applying automatically the moment
    // the season gets its first review, since count is recomputed per
    // request, not cached. Scoped to seasons specifically (parentId set) —
    // a standalone reviewless movie/book/game still has its own genuinely
    // unique metadata even with zero reviews, so it doesn't have the same
    // near-duplicate-cluster problem.
    const isReviewlessSeason = !!item.parentId && count === 0;
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

    // External community scores — deliberately rendered as plain attributed
    // text and NOT folded into the aggregateRating JSON-LD below.
    // aggregateRating must describe ratings THIS site collected; passing
    // TMDB's or IGDB's off as ours would misrepresent a third party's data
    // and is exactly the kind of structured-data misuse Google penalises.
    // Mirrors the meta-chips item.html already shows (TMDB 7.7 / IGDB 82).
    const externalBits = [
      ...(item.tmdbRating      ? [`TMDB ${item.tmdbRating.toFixed(1)}/10`] : []),
      ...(item.openCriticScore ? [`IGDB ${item.openCriticScore}/100`]      : []),
    ];
    const externalHtml = externalBits.length
      ? `<div class="meta">Elsewhere: ${externalBits.map(esc).join(' · ')}</div>`
      : '';

    // Where to watch — the single biggest piece of genuinely differentiating,
    // regularly-refreshed content these pages have (synced weekly by
    // scripts/sync-streaming-providers.js, US region, JustWatch via TMDB).
    // It was previously rendered only on the real page, leaving crawlers with
    // a TMDB synopsis and nothing else on titles that had no reviews yet.
    // Display logic intentionally mirrors item.html's exactly — subscription
    // (flatrate) first, falling back to rent/buy — because prerendered output
    // that diverges from what a user sees is cloaking. Note this differs from
    // Browse's platform FILTER, which is flatrate-only by design; that's a
    // filtering decision, this is a display one.
    // TMDB's terms require crediting JustWatch by name wherever this data is
    // shown (see CLAUDE.md / item.html) — don't drop that attribution.
    let streamingHtml = '';
    let streamingSummary = '';
    const sp = item.streamingProviders;
    if ((item.mediaType === 'MOVIE' || item.mediaType === 'TV_SHOW') && sp) {
      const flatrate = sp.flatrate || [];
      const rentBuy = [...(sp.rent || []), ...(sp.buy || [])]
        .filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i);
      const providers = flatrate.length ? flatrate : rentBuy;
      if (providers.length && sp.link) {
        const label = flatrate.length
          ? 'Streaming in the US on'
          : 'Available to rent or buy in the US on';
        // TMDB lists storefront resellers of a service ("HBO Max Amazon
        // Channel", "Paramount+ Roku Premium Channel") and ad-tier variants
        // as separate providers alongside the service itself, and returns
        // them in no useful order — Prometheus led with "HBO Max Amazon
        // Channel" ahead of plain "HBO Max". Nearly every major service has
        // such a shadow entry (verified against the catalog: 10.8k rows for
        // "Amazon Prime Video with Ads" vs 10.9k for "Amazon Prime Video"),
        // so without this the recognisable name often loses the snippet slot
        // it needs to be worth anything in search results. Stable partition,
        // so the reseller entries are demoted rather than dropped.
        const isReseller = n => /(Amazon Channel|Apple TV Channel|Roku Premium Channel|with Ads)$/i.test(n);
        const ordered = [
          ...providers.filter(p => !isReseller(p.name)),
          ...providers.filter(p =>  isReseller(p.name)),
        ];
        const names = ordered.slice(0, 8).map(p => p.name);
        streamingHtml = `
  <h2>Where to Watch</h2>
  <p>${esc(label)} ${esc(names.join(', '))}.</p>
  <p style="font-size:0.85em;color:#7A6E5A">Streaming data by <a href="${esc(sp.link)}" rel="noopener">JustWatch</a>.</p>`;
        // Folded into the meta description too — on a title with no reviews
        // this is the only thing making that snippet differ from every other
        // site running the same TMDB synopsis.
        streamingSummary = flatrate.length
          ? ` Now streaming on ${names.slice(0, 3).join(', ')}.`
          : ` Available to rent or buy on ${names.slice(0, 3).join(', ')}.`;
      } else {
        streamingHtml = `
  <h2>Where to Watch</h2>
  <p>Not currently available to stream, rent, or buy in the US.</p>`;
      }
    }

    // `desc` is built above before streaming is known; this is the version
    // that actually goes in the meta/og description tags.
    const metaDesc = `${desc}${streamingSummary}`;

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
  ${isReviewlessSeason ? '<meta name="robots" content="noindex,follow">' : ''}
  <title>${esc(title)}${esc(year)} — Is It (Still) Good?</title>
  <meta name="description" content="${esc(metaDesc)}">
  <meta property="og:title" content="${esc(title)}${esc(year)} — Is It (Still) Good?">
  <meta property="og:description" content="${esc(metaDesc)}">
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
  ${externalHtml}
  ${item.description ? `<div class="desc">${esc(item.description)}</div>` : ''}
  ${castList ? `<p><strong>Cast:</strong> ${esc(castList)}</p>` : ''}
  ${streamingHtml}
  <hr>
  <h2>Community Reviews</h2>
  ${reviewsHtml || '<p>No reviews yet — be the first!</p>'}
  <p style="margin-top:24px"><a href="${BASE}/item.html?slug=${esc(item.slug)}" style="color:#C8832A">See full page with ratings &amp; more →</a></p>
</body>
</html>`);
  } catch (err) { next(err); }
});

module.exports = router;
