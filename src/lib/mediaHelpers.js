// src/lib/mediaHelpers.js — shared media data helpers.
// Used by src/routes/admin.js (the admin UI) and scripts/bulk-import.js
// (the CLI importer) so both write identical, normalized data.
const prisma = require('./prisma');

// ─── Tag and genre normalization ──────────────────────────────────────────
const TAG_OVERRIDES = {
  'hbo': 'HBO', 'hbo max': 'HBO Max', 'hbomax': 'HBO Max',
  'apple tv': 'Apple TV', 'apple tv+': 'Apple TV+',
  'nbc': 'NBC', 'cbs': 'CBS', 'abc': 'ABC', 'amc': 'AMC', 'fx': 'FX',
  'bbc': 'BBC', 'pbs': 'PBS', 'mtv': 'MTV', 'vh1': 'VH1',
  'usa': 'USA', 'tnt': 'TNT', 'tbs': 'TBS', 'syfy': 'Syfy',
  'cnn': 'CNN', 'espn': 'ESPN', 'nfl': 'NFL', 'nba': 'NBA',
  'mlb': 'MLB', 'nhl': 'NHL', 'dc': 'DC', 'mcu': 'MCU', 'dceu': 'DCEU',
  'lgbtq': 'LGBTQ', 'lgbtq+': 'LGBTQ+', 'wwii': 'WWII', 'wwi': 'WWI',
  'uk': 'UK', 'us': 'US',
};

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return tags;
  return tags.map(t => {
    const trimmed = t.trim();
    const lower   = trimmed.toLowerCase();
    if (TAG_OVERRIDES[lower]) return TAG_OVERRIDES[lower];
    return trimmed.split(' ').map(w => {
      const wl = w.toLowerCase();
      if (TAG_OVERRIDES[wl]) return TAG_OVERRIDES[wl];
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  });
}

function normalizeGenres(genres) {
  if (!Array.isArray(genres)) return genres;
  const result = [];
  for (const g of genres) {
    const parts = g.split(/\s*&\s*/);
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      if (/^sci[-\s]?fi$/i.test(s)) { result.push('Science Fiction'); continue; }
      result.push(s);
    }
  }
  return [...new Set(result)];
}

// ─── Setting genres (TV) ───────────────────────────────────────────────────
// Schools/Police/Legal/Courtroom/Medical — derived from TMDB per-show
// keyword data (see getTvKeywords in mediaLookup.js), matched by substring
// so compound keywords like "police corruption" still count as a Police
// signal. Deliberately excludes generic terms (bare "detective"/"fbi"/
// "sheriff"/"doctor") that fire on unrelated shows — see git history on
// this file and apply-setting-genres-tv.js for the false positives
// (Jessica Jones, The X-Files, Deadwood, Sherlock) that led to narrowing it.
const SETTING_GENRE_VOCAB = {
  Schools: ['school', 'elementary school', 'high school', 'middle school', 'boarding school', 'private school', 'elementary school teacher', 'high school teacher'],
  Police: ['police', 'police investigation', 'police procedural', 'homicide detective', 'nypd', 'lapd', 'female cop', 'male cop'],
  Legal: ['lawyer', 'law firm', 'legal drama', 'criminal law', 'corporate law', 'paralegal', 'attorney', 'district attorney', 'prosecutor'],
  Courtroom: ['courtroom drama', 'courtroom', 'trial', 'court case', 'jury'],
  Medical: ['medical', 'medicine', 'hospital', 'medical drama', 'emergency room'],
};

function settingGenresFor(keywords) {
  const matched = [];
  for (const [genre, terms] of Object.entries(SETTING_GENRE_VOCAB)) {
    if (terms.some(t => keywords.some(k => k.includes(t)))) matched.push(genre);
  }
  return matched;
}

// ─── Slugs ─────────────────────────────────────────────────────────────────
function slugify(title, year) {
  const base = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
  return year ? `${base}-${year}` : base;
}

async function uniqueSlug(base) {
  let slug = base, i = 1;
  while (await prisma.mediaItem.findUnique({ where: { slug } })) slug = `${base}-${i++}`;
  return slug;
}

// ─── Person relations ────────────────────────────────────────────────────
// connectPersons builds the Prisma relation payload for cast/directors/authors.
// isUpdate=true  → uses {set:[...]} which replaces the full relation (correct for PATCH)
// isUpdate=false → uses {connect:[...]} which adds relations (correct for CREATE)
// Empty names + isUpdate → {set:[]} removes all; empty + create → undefined (skip field)
async function connectPersons(names, isUpdate = false) {
  if (!names?.length) {
    return isUpdate ? { set: [] } : undefined;
  }

  const persons = await Promise.all(names.map(name => {
    const personSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return prisma.person.upsert({
      where: { slug: personSlug },
      update: { name },
      create: { name, slug: personSlug },
    });
  }));

  const ids = persons.map(p => ({ id: p.id }));
  return isUpdate ? { set: ids } : { connect: ids };
}

// Title normalization for BOOK duplicate matching — an exact (even
// case-insensitive) string match misses real near-duplicates: leading
// articles ("Blue Mage Raised by Dragons" vs "The Blue Mage Raised by
// Dragons"), spelled-out vs numeral volume numbers ("Volume One:
// 1920–1963" vs "Volume 1"), and parenthetical edition/tie-in noise. Both
// of these are confirmed-live misses, not hypothetical.
const NUMBER_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
function normalizeBookTitle(t) {
  let s = (t || '').toLowerCase();
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ');   // strip parenthetical edition/series notes
  // NOTE: deliberately does NOT truncate at colon — "Mother of Learning:
  // Arc 1" vs "Arc 4" and "The Land: Founding" vs "Forging" showed live
  // that the text after a colon is often the part that distinguishes
  // different volumes in a series, not decorative subtitle fluff. Blindly
  // stripping it caused real false-positive matches between genuinely
  // different books. See bookTitlesMatch() for how the remaining
  // same-book-different-subtitle-completeness case (e.g. "Volume One:
  // 1920–1963" vs "Volume 1") is handled more conservatively instead.
  s = s.replace(/^(the|a|an)\s+/i, '');       // strip leading article
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => NUMBER_WORDS[w]);
  return s.replace(/\s+/g, ' ').trim();
}

// Exact match after normalization ONLY — deliberately no prefix/fuzzy
// leniency. A prefix-match variant was tried and tried again (60% length
// floor, requiring a trailing space) and still produced two different
// false-positive patterns live: "Mother of Learning: Arc 1" vs "Arc 4"
// (colon+suffix distinguishes volumes) and "He Who Fights With Monsters"
// vs "...Monsters 2" (bare trailing number distinguishes volumes) both
// matched as "the same book" when they're sequential, genuinely different
// entries. Numbered-series naming is too common in this catalog (LitRPG/
// fantasy series) for prefix-matching to be safe. A same-book-different-
// subtitle-completeness case (e.g. "Volume One: 1920–1963" vs "Volume 1")
// will be missed by exact-match — that's an acceptable false negative
// (occasional uncaught duplicate, fixable later) vs. the false positive
// risk of deleting a real, different book.
function bookTitlesMatch(a, b) {
  const na = normalizeBookTitle(a), nb = normalizeBookTitle(b);
  return !!na && na === nb;
}

// ─── Duplicate detection ──────────────────────────────────────────────────
// Mirrors GET /api/admin/check-duplicate — checks by external ID first
// (most reliable), then falls back to a case-insensitive title match.
async function findDuplicate({ title, mediaType, tmdbId, igdbId, openLibraryId, releaseYear, authors }) {
  const idChecks = [];
  if (tmdbId) {
    const tmdbCheck = { tmdbId };
    if (mediaType === 'MOVIE')   tmdbCheck.mediaType = 'MOVIE';
    if (mediaType === 'TV_SHOW') tmdbCheck.mediaType = 'TV_SHOW';
    idChecks.push(tmdbCheck);
  }
  if (igdbId)        idChecks.push({ openCriticId: igdbId });
  if (openLibraryId) idChecks.push({ goodreadsId: openLibraryId });

  if (idChecks.length) {
    const idMatch = await prisma.mediaItem.findFirst({ where: { OR: idChecks } });
    if (idMatch) return idMatch;
  }

  if (title) {
    // BOOKS: an exact title+author match is virtually always the same work
    // in a different edition, not a genuine remake — and Google Books'
    // release-year data for self-published/indie titles is proven
    // unreliable (confirmed live: "House of Blades" resolved to 2026
    // instead of its real 2013, a 13-year gap that slipped past the ±2
    // year guard below and created a true duplicate). So for BOOK, match on
    // title+author with no year constraint at all, checked first.
    if (mediaType === 'BOOK' && authors?.length) {
      // Fetch every book by any of these authors, then compare normalized
      // titles in JS — Prisma/Postgres can't apply the article-stripping /
      // number-word / parenthetical normalization above inside a WHERE
      // clause, and an author's book count is small enough that this is
      // cheap.
      const byAuthor = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', authors: { some: { name: { in: authors, mode: 'insensitive' } } } },
      });
      const authorMatch = byAuthor.find(b => bookTitlesMatch(b.title, title));
      if (authorMatch) return authorMatch;
    }

    const titleMatch = await prisma.mediaItem.findFirst({
      where: {
        title: { equals: title.trim(), mode: 'insensitive' },
        mediaType,
        // Guard against an unrelated film/show that happens to share an exact
        // title from a different era (West Side Story 1961 vs. 2021, The
        // Color Purple 1985 vs. 2023, etc.) — a title-only match only counts
        // as the same work when release years are close. No year given (or
        // no releaseYear on the existing row) falls back to the old behavior.
        ...(releaseYear ? { OR: [{ releaseYear: null }, { releaseYear: { gte: releaseYear - 2, lte: releaseYear + 2 } }] } : {}),
      },
    });
    if (titleMatch) return titleMatch;
  }

  return null;
}

module.exports = {
  normalizeTags,
  normalizeGenres,
  settingGenresFor,
  SETTING_GENRE_VOCAB,
  slugify,
  uniqueSlug,
  connectPersons,
  findDuplicate,
  normalizeBookTitle,
  bookTitlesMatch,
};
