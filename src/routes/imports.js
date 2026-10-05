// Importing a user's ratings from another service: Letterboxd, Goodreads and
// IMDb, one preview/commit pair each.
//
// ─── Why all three are fine, when two were once removed ───────────────────
//
// Every route here reads a file the user already has. Nothing in this module
// makes a request to Letterboxd, Goodreads or IMDb — there is no API call, no
// scrape, no stored credential, no account linkage of any kind. The user
// clicks Export on the service's own site, gets a CSV, and uploads it here.
//
// That distinction is the whole argument. A Goodreads importer was built and
// removed on 2026-10-01 on the strength of the Amazon-family clause against
// exporting content from the service "unless expressly permitted by us" —
// which was the wrong clause to stop on, because both Amazon services ship a
// documented Export button for exactly this data, and IMDb's own help page
// says the resulting file is the user's to "save and adjust as you wish".
// A first-party export feature IS that express permission. What remains is a
// clause binding the *user's* use of their own account data, which is theirs
// to weigh and which data-portability law speaks to; it is not a restriction
// on a site that reads an uploaded file.
//
// The practical rule to preserve: if a future change here would make this
// server talk to any of those three services directly, that is a different
// question and needs answering on its own terms before shipping.
//
// ─── Scales ───────────────────────────────────────────────────────────────
//
//   IMDb        1-10 whole          -> used as-is. Exact, no conversion.
//   Letterboxd  0.5-5 half steps    -> x2 = a clean 1-10, nothing unreachable.
//   Goodreads   1-5 whole           -> x2 = even numbers only. Lossy; accepted.
//
// ─── Matching ─────────────────────────────────────────────────────────────
//
// Deliberately two-phase everywhere. `/preview` parses and matches but writes
// nothing; `/commit` takes back only the rows the user confirmed. The split
// exists because title+year matching is wrong about 3% of the time in a way
// that looks right — a sample import matched "Burning (2018)", Lee
// Chang-dong's film, to an unrelated "Burning (2021)" in the catalogue.
// Importing that silently would attach someone's 9/10 to a film they have
// never seen. Everything ambiguous is handed back for a human to look at.
//
// Two of the three dodge that problem with an exact key, which is why they
// need far less confirming than Letterboxd does:
//
//   IMDb       Const column   -> MediaItem.imdbId  (backfilled from TMDB)
//   Goodreads  ISBN13 column  -> MediaItem.isbn13
//   Letterboxd (none)         -> normalized title + year, with tiers
//
// Nothing here notifies friends. An import is one action by one person, not
// four hundred reviews worth of feed events — see the comment at commit().
const express = require('express');
const { body } = require('express-validator');
const { validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { prismaWithDrafts } = require('../lib/prisma');
const { normalizeTitleForSearch } = require('../lib/mediaHelpers');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Keep this in step with ratingToVerdict in reviews.js — same ten words.
function ratingToVerdict(r) {
  const words = {
    10: 'Perfect', 9: 'Excellent', 8: 'Great', 7: 'Good', 6: 'Solid',
    5: 'Fine', 4: 'Mediocre', 3: 'Bad', 2: 'Awful', 1: 'The Worst',
  };
  return words[Math.round(r)] || 'Unrated';
}

const ok = (req, res) => {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
};

// A whole library is a big paste, but not unbounded — a 5,000-film Letterboxd
// account is roughly 300KB of CSV.
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

// Minimal RFC4180. Needed because titles contain commas:
// "Lock, Stock and Two Smoking Barrels".
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.some(Boolean))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

// Serves Letterboxd and Goodreads both, since doubling is right for each.
//
// Letterboxd is 0.5-5 in half steps, so x2 lands exactly on 1-10 with no
// rounding and nothing unreachable — the reason it was the first importer.
// Goodreads is 1-5 whole stars, so the same doubling reaches only the even
// numbers: an imported library will contain no 7s or 9s until the reader
// edits them. That is a known and accepted trade (a coarser scale in is still
// better than no ratings at all), not an oversight. IMDb needs none of this.
const starsToTen = stars => {
  const n = parseFloat(stars);
  if (!Number.isFinite(n) || n <= 0 || n > 5) return null;
  return Math.round(n * 2);
};

// Goodreads writes its id columns Excel-safe, as ="9780441013593", so the raw
// cell is useless without stripping that wrapper. Empty ISBNs arrive as ="".
const unwrapGoodreadsCell = v => String(v ?? '').replace(/^="?|"?$/g, '').trim();

const isbnDigits = s => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();

// ISBN-10 -> 13 is deterministic. Normalizing to one form on the way in means
// the lookup is a single indexed equality rather than two.
function isbn10to13(raw) {
  const s = isbnDigits(raw);
  if (s.length !== 10) return null;
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}
function normalizeIsbn(raw) {
  const s = isbnDigits(raw);
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10) return isbn10to13(s);
  return null;
}



// Fetches every candidate for the whole export in one query, keyed by
// normalized title. Matching row-by-row with its own query took ~7 seconds
// for 69 films against a remote database, which would be close to a minute
// for a real 500-film library — long enough to look broken and to risk a
// proxy timeout. One `in` query is flat regardless of library size.
async function candidatesFor(rows) {
  const titles = [...new Set(
    rows.map(r => normalizeTitleForSearch((r.Name || '').trim())).filter(Boolean)
  )];
  const found = await prisma.mediaItem.findMany({
    where: { mediaType: 'MOVIE', normalizedTitle: { in: titles } },
    select: { id: true, title: true, releaseYear: true, slug: true, imageUrl: true, normalizedTitle: true },
  });
  const byTitle = new Map();
  for (const m of found) {
    if (!byTitle.has(m.normalizedTitle)) byTitle.set(m.normalizedTitle, []);
    byTitle.get(m.normalizedTitle).push(m);
  }
  return byTitle;
}

// Matches one exported row against the prefetched candidates and says how
// confident it is. `auto` rows can be written without asking; everything else
// goes back to the user. The tiers exist so a wrong year can never be
// mistaken for a match.
// Letterboxd's export is several files, and ratings.csv is only the scores.
// Written reviews live in reviews.csv, which carries the same Name/Year/Rating
// columns plus the text — so the same parser handles both files and a reader
// who wrote reviews can upload either, or both.
//
// The column is read case-insensitively from a candidate list rather than by a
// hard-coded name. Letterboxd does not publish its export schema, and this
// project has already been bitten once by building a parser against a format
// nobody documents.
const REVIEW_KEYS = ['review', 'review text', 'reviewtext', 'text'];
function reviewTextOf(row) {
  for (const [k, v] of Object.entries(row)) {
    if (!REVIEW_KEYS.includes(String(k).trim().toLowerCase())) continue;
    const t = stripHtml(v);
    if (t) return t;
  }
  return null;
}

// Letterboxd accepts HTML in a review and exports it the same way, so the raw
// cell can contain <p>/<em>/<a> and entities. Stored as plain text: the review
// field is rendered as text here, so markup would show as literal tags.
function stripHtml(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

function matchRow(row, byTitle) {
  const rating = starsToTen(row.Rating);
  const name = (row.Name || '').trim();
  const year = parseInt(row.Year, 10);
  if (!name) return null;
  if (rating === null) return { name, year, status: 'unrated' };

  const candidates = byTitle.get(normalizeTitleForSearch(name)) || [];

  const base = {
    name, year, rating,
    // reviews.csv dates the entry with "Watched Date"; ratings.csv uses "Date".
    watchedDate: row['Watched Date'] || row.Date || null,
    reviewText: reviewTextOf(row),
  };
  if (!candidates.length) return { ...base, status: 'missing', auto: false };

  const exact = candidates.filter(c => c.releaseYear === year);
  if (exact.length === 1) return { ...base, status: 'exact', auto: true, match: exact[0] };
  if (exact.length > 1) return { ...base, status: 'ambiguous', auto: false, options: exact };

  // Festival, territory and streaming dates routinely disagree by a year —
  // The Witch premiered in 2015 and released in 2016. That is a match, not a
  // coincidence, as long as only one candidate is that close.
  const near = candidates.filter(c => Math.abs((c.releaseYear || 0) - year) <= 1);
  if (near.length === 1) return { ...base, status: 'year_drift', auto: true, match: near[0] };

  // Title matches, year does not. This is the dangerous case and the reason
  // for the whole preview step, so it is never auto-imported.
  return { ...base, status: 'needs_confirmation', auto: false, options: candidates };
}

// ─── POST /api/imports/letterboxd/preview ──────────────────────────────────
// Parses, matches, writes nothing. Returns everything the confirmation screen
// needs to render.
// Accepts one CSV or several. A Letterboxd export splits a single film across
// files — ratings.csv has the score, reviews.csv has the score AND the words —
// so a reader who writes reviews has to hand over both to bring everything, and
// the film then appears twice. Merging here rather than asking them to import
// twice is the difference between one confirmation screen and two, the second
// of which would look like it was about to duplicate everything.
//
// `csv` (a single string) still works unchanged, so an older client keeps
// functioning while the frontend is deployed separately.
router.post('/letterboxd/preview', requireAuth, [
  body('csv').optional().isString(),
  body('csvs').optional().isArray({ max: 4 }),
  body('csvs.*').isString(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const files = req.body.csvs?.length ? req.body.csvs : (req.body.csv ? [req.body.csv] : []);
    if (!files.length) return res.status(422).json({ error: 'No file received.' });

    const totalBytes = files.reduce((n, c) => n + Buffer.byteLength(c, 'utf8'), 0);
    if (totalBytes > MAX_CSV_BYTES * 2) {
      return res.status(413).json({ error: 'Those files are larger than this importer accepts.' });
    }

    const parsed = files.map(parseCsv).filter(r => r.length);
    if (!parsed.length) return res.status(422).json({ error: 'No rows found in that file.' });
    if (!parsed.some(r => 'Name' in r[0] && 'Rating' in r[0])) {
      return res.status(422).json({
        error: 'That does not look like a Letterboxd export. Expected columns Name, Year and Rating — use ratings.csv and/or reviews.csv from Letterboxd’s Export Your Data.',
      });
    }

    // One row per film. A film that was reviewed is listed in both files with
    // the same score, so the copy carrying the written review wins — otherwise
    // whichever file happened to be read last would decide whether the words
    // survived.
    const merged = new Map();
    for (const rows of parsed) {
      for (const row of rows) {
        const name = (row.Name || '').trim();
        if (!name) continue;
        const key = `${normalizeTitleForSearch(name)}|${(row.Year || '').trim()}`;
        const prev = merged.get(key);
        if (!prev) { merged.set(key, row); continue; }
        if (!reviewTextOf(prev) && reviewTextOf(row)) merged.set(key, { ...prev, ...row });
      }
    }
    const rows = [...merged.values()];

    if (rows.length > MAX_ROWS) {
      return res.status(413).json({ error: `That export has ${rows.length} films; this importer handles up to ${MAX_ROWS} at once.` });
    }

    const byTitle = await candidatesFor(rows);
    const results = [];
    for (const row of rows) {
      const m = matchRow(row, byTitle);
      if (m) results.push(m);
    }

    // Flag anything already reviewed so the UI can say "this will update your
    // existing rating" rather than quietly overwriting it.
    const matchedIds = results.filter(r => r.match).map(r => r.match.id);
    const already = matchedIds.length
      ? await prismaWithDrafts.review.findMany({
          where: { userId: req.user.id, mediaItemId: { in: matchedIds } },
          select: { mediaItemId: true, rating: true },
        })
      : [];
    const existingBy = Object.fromEntries(already.map(r => [r.mediaItemId, r.rating]));
    results.forEach(r => { if (r.match && existingBy[r.match.id] !== undefined) r.existingRating = existingBy[r.match.id]; });

    const by = s => results.filter(r => r.status === s).length;
    res.json({
      total: results.length,
      summary: {
        exact: by('exact'),
        yearDrift: by('year_drift'),
        needsConfirmation: by('needs_confirmation'),
        ambiguous: by('ambiguous'),
        missing: by('missing'),
        unrated: by('unrated'),
        autoImportable: results.filter(r => r.auto).length,
        alreadyReviewed: results.filter(r => r.existingRating !== undefined).length,
      },
      rows: results,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/imports/letterboxd/commit ───────────────────────────────────
// Takes back only what the user confirmed:
// [{ mediaItemId, rating, watchedDate, reviewText }].
// The server re-validates every field; the preview response is a suggestion,
// not something to trust on the way back in.
router.post('/letterboxd/commit', requireAuth, [
  body('items').isArray({ min: 1, max: MAX_ROWS }),
  body('items.*.mediaItemId').isString().notEmpty(),
  body('items.*.rating').isInt({ min: 1, max: 10 }),
  body('items.*.watchedDate').optional({ nullable: true }).isISO8601(),
  body('items.*.reviewText').optional({ nullable: true }).isString().isLength({ max: 5000 }),
  body('visibility').optional().isIn(['PUBLIC', 'FRIENDS_ONLY', 'PRIVATE']),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const { items } = req.body;
    const vis = req.body.visibility || req.user.defaultVisibility || 'PUBLIC';

    // One query instead of one per row — an import is the only place this
    // route sees hundreds of ids at once.
    const ids = [...new Set(items.map(i => i.mediaItemId))];
    const media = await prisma.mediaItem.findMany({
      where: { id: { in: ids }, mediaType: 'MOVIE' },
      select: { id: true },
    });
    const valid = new Set(media.map(m => m.id));

    // Draft-aware, for the same reason the normal review route is: a read
    // through `prisma` cannot see drafts, so an existing draft would be
    // missed here and the insert would trip the user+item+season constraint.
    const existing = await prismaWithDrafts.review.findMany({
      where: { userId: req.user.id, mediaItemId: { in: ids }, seasonNumber: null },
      select: { id: true, mediaItemId: true, rating: true, isDraft: true },
    });
    const existingBy = Object.fromEntries(existing.map(r => [r.mediaItemId, r]));

    let created = 0, updated = 0, skipped = 0;
    for (const item of items) {
      if (!valid.has(item.mediaItemId)) { skipped++; continue; }
      const rating = parseInt(item.rating, 10);
      const verdict = ratingToVerdict(rating);
      const consumed = item.watchedDate ? new Date(item.watchedDate) : null;
      const dateConsumed = consumed && consumed.getTime() <= Date.now() ? consumed : null;
      const reviewText = item.reviewText ? String(item.reviewText).slice(0, 5000) : null;
      const prior = existingBy[item.mediaItemId];

      if (prior) {
        await prisma.review.update({
          where: { id: prior.id },
          data: {
            rating, verdict, dateConsumed, visibility: vis, isDraft: false,
            // Only ever fills review text, never blanks one. Someone who
            // imported ratings.csv first and reviews.csv second should gain
            // their words; someone who wrote a review here and then re-imports
            // should not lose it to a row that carries none.
            ...(reviewText ? { reviewText } : {}),
            // A re-import that changes a score is a revisit in the same sense
            // a manual edit is.
            isRevisit: prior.isDraft ? false : (rating !== prior.rating ? true : undefined),
            previousRating: prior.isDraft ? null : (rating !== prior.rating ? prior.rating : undefined),
          },
        });
        updated++;
      } else {
        await prisma.review.create({
          data: {
            userId: req.user.id, mediaItemId: item.mediaItemId,
            rating, verdict, dateConsumed, visibility: vis, reviewText,
            seasonNumber: null, isRevisit: false, isDraft: false,
          },
        });
        created++;
      }
    }

    // No notifyFriends anywhere in this route, on purpose. The normal review
    // endpoint tells every friend about every review, which is right for one
    // deliberate act and catastrophic for four hundred of them arriving at
    // once — it would bury every other person's activity in the feed and read
    // as spam. An import is one event about a person, not N events about
    // films; if it should appear in the feed at all it belongs as a single
    // "imported N ratings" entry, which is a feed-model change rather than
    // something to bolt on here.
    res.status(201).json({ created, updated, skipped, total: created + updated });
  } catch (err) { next(err); }
});

// ═══ Goodreads ═════════════════════════════════════════════════════════════
// Same two-phase shape as Letterboxd, but the matching is better and the
// ratings are worse.
//
// Better: the export carries an ISBN, which matches an exact key. Note it is
// matched against MediaItem.isbns — the full set across every edition — and
// NOT against the single isbn13. That distinction is the whole game: a
// Goodreads row carries the ISBN of the edition that reader shelved, and a
// work has many (Jurassic Park: 94 editions, 73 distinct ISBN-13s), so
// comparing one stored value to one shelved value missed almost everything.
//
// Worse: 1-5 whole stars, so an import lands only on even numbers. Accepted
// deliberately — see starsToTen.
//
// The export also includes shelved-but-unread books with "My Rating" of 0;
// those are skipped rather than imported as a rating of nothing.

// One query for ISBNs, one for titles, rather than two per row.
async function goodreadsCandidates(rows) {
  const isbns = [...new Set(rows.map(r => normalizeIsbn(unwrapGoodreadsCell(r.ISBN13) || unwrapGoodreadsCell(r.ISBN))).filter(Boolean))];
  const titles = [...new Set(rows.map(r => normalizeTitleForSearch((r.Title || '').trim())).filter(Boolean))];

  const [byIsbnRows, byTitleRows] = await Promise.all([
    // hasSome against the edition set, GIN-indexed. isbn13 stays in the OR so
    // books the set backfill hasn't reached yet still match on their canonical
    // value rather than silently regressing.
    isbns.length ? prisma.mediaItem.findMany({
      where: { mediaType: 'BOOK', OR: [{ isbns: { hasSome: isbns } }, { isbn13: { in: isbns } }] },
      select: { id: true, title: true, releaseYear: true, slug: true, imageUrl: true, isbn13: true, isbns: true,
                authors: { select: { name: true } } },
    }) : [],
    prisma.mediaItem.findMany({
      where: { mediaType: 'BOOK', normalizedTitle: { in: titles } },
      select: { id: true, title: true, releaseYear: true, slug: true, imageUrl: true, normalizedTitle: true,
                authors: { select: { name: true } } },
    }),
  ]);

  // Keyed by EVERY ISBN the book is known by, not just its canonical one —
  // otherwise the edition-set lookup above would find the right book and then
  // fail to retrieve it, because the reader shelved a different edition than
  // the one we happen to store in isbn13.
  const byIsbn = new Map();
  for (const m of byIsbnRows) {
    for (const key of new Set([...(m.isbns || []), m.isbn13].filter(Boolean))) {
      // First writer wins: distinct rows legitimately share an ISBN (an
      // omnibus and its volumes), and silently reassigning the key would make
      // which book you get depend on query order.
      if (!byIsbn.has(key)) byIsbn.set(key, m);
    }
  }
  const byTitle = new Map();
  for (const m of byTitleRows) {
    if (!byTitle.has(m.normalizedTitle)) byTitle.set(m.normalizedTitle, []);
    byTitle.get(m.normalizedTitle).push(m);
  }
  return { byIsbn, byTitle };
}

const surnameTokens = names => new Set(
  names.flatMap(n => normalizeTitleForSearch(n).split(' ')).filter(t => t.length > 2)
);

function matchGoodreadsRow(row, { byIsbn, byTitle }) {
  const title = (row.Title || '').trim();
  if (!title) return null;

  const rating = starsToTen(row['My Rating']);
  // 0 stars means shelved, not rated — a want-to-read is not an opinion.
  if (rating === null) return { name: title, status: 'unrated' };

  const author = (row.Author || '').trim();
  const isbn = normalizeIsbn(unwrapGoodreadsCell(row.ISBN13) || unwrapGoodreadsCell(row.ISBN));
  const base = {
    name: title, author, rating, isbn,
    watchedDate: (row['Date Read'] || '').trim() || null,
    reviewText: (row['My Review'] || '').trim() || null,
  };

  // ISBN is an exact key — if it hits, nothing else needs checking.
  if (isbn && byIsbn.has(isbn)) return { ...base, status: 'isbn', auto: true, match: byIsbn.get(isbn) };

  const candidates = byTitle.get(normalizeTitleForSearch(title)) || [];
  if (!candidates.length) return { ...base, status: 'missing', auto: false };

  // Falling back to title, the author has to agree — a title alone is how
  // "Self" by Yann Martel ended up wearing Brandon Sanderson's cover.
  if (author) {
    const want = surnameTokens([author]);
    const byAuthor = candidates.filter(c => {
      const theirs = surnameTokens(c.authors.map(a => a.name));
      return [...want].some(t => theirs.has(t));
    });
    if (byAuthor.length === 1) return { ...base, status: 'title_author', auto: true, match: byAuthor[0] };
    if (byAuthor.length > 1) return { ...base, status: 'ambiguous', auto: false, options: byAuthor };
  }

  // Title matches but the author does not, or we have no author to check.
  return { ...base, status: 'needs_confirmation', auto: false, options: candidates };
}

// ─── POST /api/imports/goodreads/preview ───────────────────────────────────
router.post('/goodreads/preview', requireAuth, [
  body('csv').isString().notEmpty().withMessage('csv is required'),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const { csv } = req.body;
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
      return res.status(413).json({ error: 'That file is larger than this importer accepts (2MB).' });
    }
    const rows = parseCsv(csv);
    if (!rows.length) return res.status(422).json({ error: 'No rows found in that file.' });
    if (!('Title' in rows[0]) || !('My Rating' in rows[0])) {
      return res.status(422).json({
        error: 'That does not look like a Goodreads export. Expected columns Title, Author and My Rating — use the file from Goodreads’ My Books → Import and export.',
      });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(413).json({ error: `That export has ${rows.length} rows; this importer handles up to ${MAX_ROWS} at once.` });
    }

    const maps = await goodreadsCandidates(rows);
    const results = [];
    for (const row of rows) {
      const m = matchGoodreadsRow(row, maps);
      if (m) results.push(m);
    }

    const matchedIds = results.filter(r => r.match).map(r => r.match.id);
    const already = matchedIds.length
      ? await prismaWithDrafts.review.findMany({
          where: { userId: req.user.id, mediaItemId: { in: matchedIds } },
          select: { mediaItemId: true, rating: true },
        })
      : [];
    const existingBy = Object.fromEntries(already.map(r => [r.mediaItemId, r.rating]));
    results.forEach(r => { if (r.match && existingBy[r.match.id] !== undefined) r.existingRating = existingBy[r.match.id]; });

    const by = s => results.filter(r => r.status === s).length;
    res.json({
      total: results.length,
      summary: {
        isbn: by('isbn'),
        titleAuthor: by('title_author'),
        needsConfirmation: by('needs_confirmation'),
        ambiguous: by('ambiguous'),
        missing: by('missing'),
        unrated: by('unrated'),
        autoImportable: results.filter(r => r.auto).length,
        alreadyReviewed: results.filter(r => r.existingRating !== undefined).length,
      },
      rows: results,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/imports/goodreads/commit ────────────────────────────────────
// Books, so the media type check differs from the Letterboxd commit; the rest
// of the behaviour (draft-aware upsert, no friend notifications, server-side
// revalidation) is deliberately identical.
router.post('/goodreads/commit', requireAuth, [
  body('items').isArray({ min: 1, max: MAX_ROWS }),
  body('items.*.mediaItemId').isString().notEmpty(),
  body('items.*.rating').isInt({ min: 1, max: 10 }),
  body('items.*.watchedDate').optional({ nullable: true }).isISO8601(),
  body('items.*.reviewText').optional({ nullable: true }).isString().isLength({ max: 5000 }),
  body('visibility').optional().isIn(['PUBLIC', 'FRIENDS_ONLY', 'PRIVATE']),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const { items } = req.body;
    const vis = req.body.visibility || req.user.defaultVisibility || 'PUBLIC';
    const ids = [...new Set(items.map(i => i.mediaItemId))];

    const media = await prisma.mediaItem.findMany({
      where: { id: { in: ids }, mediaType: 'BOOK' },
      select: { id: true },
    });
    const valid = new Set(media.map(m => m.id));

    const existing = await prismaWithDrafts.review.findMany({
      where: { userId: req.user.id, mediaItemId: { in: ids }, seasonNumber: null },
      select: { id: true, mediaItemId: true, rating: true, isDraft: true },
    });
    const existingBy = Object.fromEntries(existing.map(r => [r.mediaItemId, r]));

    let created = 0, updated = 0, skipped = 0;
    for (const item of items) {
      if (!valid.has(item.mediaItemId)) { skipped++; continue; }
      const rating = parseInt(item.rating, 10);
      const verdict = ratingToVerdict(rating);
      const d = item.watchedDate ? new Date(item.watchedDate) : null;
      const dateConsumed = d && !isNaN(d) && d.getTime() <= Date.now() ? d : null;
      const reviewText = item.reviewText ? String(item.reviewText).slice(0, 5000) : null;
      const prior = existingBy[item.mediaItemId];

      if (prior) {
        await prisma.review.update({
          where: { id: prior.id },
          data: {
            rating, verdict, dateConsumed, visibility: vis, isDraft: false,
            // Only fill review text, never blank one the reader already wrote
            // here — their own words outrank an imported blank.
            ...(reviewText ? { reviewText } : {}),
            isRevisit: prior.isDraft ? false : (rating !== prior.rating ? true : undefined),
            previousRating: prior.isDraft ? null : (rating !== prior.rating ? prior.rating : undefined),
          },
        });
        updated++;
      } else {
        await prisma.review.create({
          data: {
            userId: req.user.id, mediaItemId: item.mediaItemId,
            rating, verdict, dateConsumed, visibility: vis, reviewText,
            seasonNumber: null, isRevisit: false, isDraft: false,
          },
        });
        created++;
      }
    }

    // No notifyFriends — same reasoning as the Letterboxd commit above.
    res.status(201).json({ created, updated, skipped, total: created + updated });
  } catch (err) { next(err); }
});

// ═══ IMDb ══════════════════════════════════════════════════════════════════
// The best of the three, for two reasons that have nothing to do with IMDb
// being big:
//
//   1. "Your Rating" is already 1-10. No doubling, no rounding, no
//      unreachable values — the only importer that reproduces what the user
//      actually chose.
//   2. The Const column is the `tt…` id, which matches MediaItem.imdbId
//      exactly. Everything with a backfilled id skips title+year guessing
//      altogether, so the confirmation step becomes a courtesy for the
//      leftovers rather than a safeguard against silent mismatches.
//
// Covers movies and whole TV shows. IMDb has no concept of rating a season,
// so a show rating is written against the TV *parent* row with
// seasonNumber: null — which is already how this schema spells "the show as
// a whole" (note that seasonNumber: 0 means something else entirely: it is
// the BOOK-series sentinel, and every read site guards it on mediaType).
//
// Episode rows are reported and skipped rather than rolled up into their
// show: averaging someone's episode ratings into a series verdict would be
// inventing an opinion they never expressed.

// IMDb's Title Type vocabulary, mapped onto this catalogue. Anything absent
// here is surfaced to the user as unsupported instead of being guessed at.
const IMDB_TITLE_TYPES = {
  movie: 'MOVIE', tvMovie: 'MOVIE', short: 'MOVIE', tvShort: 'MOVIE',
  video: 'MOVIE', tvSpecial: 'MOVIE',
  tvSeries: 'TV_SHOW', tvMiniSeries: 'TV_SHOW',
};

const imdbConst = v => {
  const s = String(v ?? '').trim();
  return /^tt\d+$/.test(s) ? s : null;
};

// IMDb's own scale, used verbatim. The only validation needed is that it is a
// whole number in range — a blank means the row is in a list but unrated.
const imdbRating = v => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 10) return null;
  return n;
};

// Two queries regardless of library size: one on the exact ids, one on titles
// for whatever has no id on either side.
async function imdbCandidates(rows) {
  const ids = [...new Set(rows.map(r => imdbConst(r.Const)).filter(Boolean))];
  const titles = [...new Set(rows.map(r => normalizeTitleForSearch((r.Title || '').trim())).filter(Boolean))];

  // Only movies and TV parent rows are ever eligible, which is also exactly
  // the set the backfill populates — so an imdbId hit is already the right row.
  const scope = [{ mediaType: 'MOVIE' }, { mediaType: 'TV_SHOW', parentId: null }];
  const select = {
    id: true, title: true, releaseYear: true, slug: true, imageUrl: true,
    mediaType: true, imdbId: true, normalizedTitle: true,
  };

  const [byIdRows, byTitleRows] = await Promise.all([
    ids.length ? prisma.mediaItem.findMany({ where: { imdbId: { in: ids }, OR: scope }, select }) : [],
    titles.length ? prisma.mediaItem.findMany({ where: { normalizedTitle: { in: titles }, OR: scope }, select }) : [],
  ]);

  const byId = new Map(byIdRows.map(m => [m.imdbId, m]));
  const byTitle = new Map();
  for (const m of byTitleRows) {
    const key = `${m.mediaType}:${m.normalizedTitle}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(m);
  }
  return { byId, byTitle };
}

function matchImdbRow(row, { byId, byTitle }) {
  const title = (row.Title || '').trim();
  if (!title) return null;

  const rawType = (row['Title Type'] || '').trim();
  const rating = imdbRating(row['Your Rating']);
  const year = parseInt(row.Year, 10);
  const base = {
    name: title, year: Number.isFinite(year) ? year : null, rating,
    titleType: rawType,
    watchedDate: (row['Date Rated'] || '').trim() || null,
  };

  // An unrated row is a watchlist entry, not an opinion.
  if (rating === null) return { ...base, status: 'unrated' };

  // Episodes before type mapping, so the message can be specific about why.
  if (rawType === 'tvEpisode') return { ...base, status: 'episode', auto: false };

  const mediaType = IMDB_TITLE_TYPES[rawType];
  if (!mediaType) return { ...base, status: 'unsupported', auto: false };
  base.mediaType = mediaType;

  // The exact key. Note the type is not re-checked against the row's Title
  // Type here: if IMDb and this catalogue disagree about whether something is
  // a TV movie or a feature, the id is still the more reliable of the two.
  const id = imdbConst(row.Const);
  if (id && byId.has(id)) return { ...base, status: 'imdb_id', auto: true, match: byId.get(id) };

  // Fallback, only for rows with no id on one side or the other. Same tiers as
  // Letterboxd, for the same reason.
  const candidates = byTitle.get(`${mediaType}:${normalizeTitleForSearch(title)}`) || [];
  if (!candidates.length) return { ...base, status: 'missing', auto: false };

  const exact = candidates.filter(c => c.releaseYear === year);
  if (exact.length === 1) return { ...base, status: 'exact', auto: true, match: exact[0] };
  if (exact.length > 1) return { ...base, status: 'ambiguous', auto: false, options: exact };

  const near = candidates.filter(c => Math.abs((c.releaseYear || 0) - year) <= 1);
  if (near.length === 1) return { ...base, status: 'year_drift', auto: true, match: near[0] };

  return { ...base, status: 'needs_confirmation', auto: false, options: candidates };
}

// ─── POST /api/imports/imdb/preview ────────────────────────────────────────
router.post('/imdb/preview', requireAuth, [
  body('csv').isString().notEmpty().withMessage('csv is required'),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const { csv } = req.body;
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
      return res.status(413).json({ error: 'That file is larger than this importer accepts (2MB).' });
    }
    const rows = parseCsv(csv);
    if (!rows.length) return res.status(422).json({ error: 'No rows found in that file.' });
    if (!('Title' in rows[0]) || !('Your Rating' in rows[0])) {
      return res.status(422).json({
        error: 'That does not look like an IMDb ratings export. Expected columns Const, Title and Your Rating — use the file from the Export button on your Your Ratings page.',
      });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(413).json({ error: `That export has ${rows.length} rows; this importer handles up to ${MAX_ROWS} at once.` });
    }

    const maps = await imdbCandidates(rows);
    const results = [];
    for (const row of rows) {
      const m = matchImdbRow(row, maps);
      if (m) results.push(m);
    }

    const matchedIds = results.filter(r => r.match).map(r => r.match.id);
    const already = matchedIds.length
      ? await prismaWithDrafts.review.findMany({
          where: { userId: req.user.id, mediaItemId: { in: matchedIds }, seasonNumber: null },
          select: { mediaItemId: true, rating: true },
        })
      : [];
    const existingBy = Object.fromEntries(already.map(r => [r.mediaItemId, r.rating]));
    results.forEach(r => { if (r.match && existingBy[r.match.id] !== undefined) r.existingRating = existingBy[r.match.id]; });

    const by = s => results.filter(r => r.status === s).length;
    res.json({
      total: results.length,
      summary: {
        imdbId: by('imdb_id'),
        exact: by('exact'),
        yearDrift: by('year_drift'),
        needsConfirmation: by('needs_confirmation'),
        ambiguous: by('ambiguous'),
        missing: by('missing'),
        unrated: by('unrated'),
        episode: by('episode'),
        unsupported: by('unsupported'),
        autoImportable: results.filter(r => r.auto).length,
        alreadyReviewed: results.filter(r => r.existingRating !== undefined).length,
      },
      rows: results,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/imports/imdb/commit ─────────────────────────────────────────
// Movies and TV parent rows. Otherwise identical to the two commits above.
router.post('/imdb/commit', requireAuth, [
  body('items').isArray({ min: 1, max: MAX_ROWS }),
  body('items.*.mediaItemId').isString().notEmpty(),
  body('items.*.rating').isInt({ min: 1, max: 10 }),
  body('items.*.watchedDate').optional({ nullable: true }).isISO8601(),
  body('visibility').optional().isIn(['PUBLIC', 'FRIENDS_ONLY', 'PRIVATE']),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const { items } = req.body;
    const vis = req.body.visibility || req.user.defaultVisibility || 'PUBLIC';
    const ids = [...new Set(items.map(i => i.mediaItemId))];

    // A season row must be refused even though it is a TV_SHOW: IMDb cannot
    // have produced a season rating, so one arriving here means a tampered or
    // stale payload rather than anything the user chose.
    const media = await prisma.mediaItem.findMany({
      where: {
        id: { in: ids },
        OR: [{ mediaType: 'MOVIE' }, { mediaType: 'TV_SHOW', parentId: null }],
      },
      select: { id: true },
    });
    const valid = new Set(media.map(m => m.id));

    const existing = await prismaWithDrafts.review.findMany({
      where: { userId: req.user.id, mediaItemId: { in: ids }, seasonNumber: null },
      select: { id: true, mediaItemId: true, rating: true, isDraft: true },
    });
    const existingBy = Object.fromEntries(existing.map(r => [r.mediaItemId, r]));

    let created = 0, updated = 0, skipped = 0;
    for (const item of items) {
      if (!valid.has(item.mediaItemId)) { skipped++; continue; }
      const rating = parseInt(item.rating, 10);
      const verdict = ratingToVerdict(rating);
      const d = item.watchedDate ? new Date(item.watchedDate) : null;
      const dateConsumed = d && !isNaN(d) && d.getTime() <= Date.now() ? d : null;
      const prior = existingBy[item.mediaItemId];

      if (prior) {
        await prisma.review.update({
          where: { id: prior.id },
          data: {
            rating, verdict, dateConsumed, visibility: vis, isDraft: false,
            isRevisit: prior.isDraft ? false : (rating !== prior.rating ? true : undefined),
            previousRating: prior.isDraft ? null : (rating !== prior.rating ? prior.rating : undefined),
          },
        });
        updated++;
      } else {
        await prisma.review.create({
          data: {
            userId: req.user.id, mediaItemId: item.mediaItemId,
            rating, verdict, dateConsumed, visibility: vis,
            seasonNumber: null, isRevisit: false, isDraft: false,
          },
        });
        created++;
      }
    }

    // No notifyFriends — same reasoning as the Letterboxd commit above.
    res.status(201).json({ created, updated, skipped, total: created + updated });
  } catch (err) { next(err); }
});

module.exports = router;
