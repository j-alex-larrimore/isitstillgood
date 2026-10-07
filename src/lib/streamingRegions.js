// src/lib/streamingRegions.js — where a title can actually be watched, by country.
//
// streamingProviders was a single unlabelled block that was always US data,
// because getWatchProviders defaults to region 'US'. That was invisible while
// every visitor was American. It stopped being invisible when the ads started
// delivering entirely to Australia: 29,501 films and shows were telling
// Australian visitors about services they may not have, and omitting the ones
// they do.
//
// The shape is now keyed by country:
//
//   { "US": { link, flatrate: [...], rent: [...], buy: [...] }, "AU": {...} }
//
// Rows written before this change hold the old unkeyed shape. Both are read
// here rather than in four separate call sites, so a half-migrated table
// cannot produce a half-broken page.

// Which regions the sync fetches. Each one costs a TMDB call per title per
// run, so this is the advertised markets rather than everywhere TMDB knows
// about — adding a country is one entry here and one re-run.
const REGIONS = ['US', 'CA', 'AU', 'GB'];

// What to show someone whose country we do not carry. US rather than nothing:
// a Spanish visitor is better served by "here is where it streams in the US,
// which may not apply to you" than by an empty panel, as long as the page
// says which country it is showing — which is why regionUsed is returned.
const FALLBACK_REGION = 'US';

const isBlock = v => !!v && typeof v === 'object'
  && ('flatrate' in v || 'rent' in v || 'buy' in v || 'link' in v);

// True for the old unkeyed shape, which was always US.
const isLegacy = json => isBlock(json);

/**
 * Pick the right country's availability out of a stored value.
 * Returns { providers, regionUsed, exact } — exact is false when the visitor's
 * own country was not available and they are being shown the fallback, which
 * the page must say out loud rather than implying the data is local.
 */
function providersFor(json, country) {
  if (!json || typeof json !== 'object') return { providers: null, regionUsed: null, exact: false };

  // Pre-migration rows: one unlabelled block, always US.
  if (isLegacy(json)) {
    return {
      providers: json,
      regionUsed: 'US',
      exact: String(country || '').toUpperCase() === 'US',
    };
  }

  const want = String(country || '').toUpperCase();
  if (want && isBlock(json[want])) {
    return { providers: json[want], regionUsed: want, exact: true };
  }
  if (isBlock(json[FALLBACK_REGION])) {
    return { providers: json[FALLBACK_REGION], regionUsed: FALLBACK_REGION, exact: false };
  }

  // Nothing for them and no fallback: say so rather than inventing a region.
  return { providers: null, regionUsed: null, exact: false };
}

/** Does this block list anything at all? */
const hasAny = p => !!p && (
  (p.flatrate || []).length || (p.rent || []).length || (p.buy || []).length
);

module.exports = { REGIONS, FALLBACK_REGION, providersFor, hasAny, isLegacy };
