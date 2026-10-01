// Importing a user's ratings from another service.
//
// Letterboxd first: its export is the only one whose scale maps to this
// site's without loss (0.5-5 in half steps x2 = a clean 1-10), and movies
// are the one media type where every row has a tmdbId, so the catalogue
// side is as good as it gets.
//
// Deliberately two-phase. POST /letterboxd/preview parses and matches but
// writes nothing; POST /letterboxd/commit takes back the rows the user
// confirmed. The split exists because title+year matching is wrong about
// 3% of the time in a way that looks right — a sample import matched
// "Burning (2018)", Lee Chang-dong's film, to an unrelated "Burning (2021)"
// in the catalogue. Importing that silently would attach someone's 9/10 to
// a film they have never seen. Everything ambiguous is handed back for a
// human to look at instead.
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

// Letterboxd is 0.5-5 in half steps. Doubling lands exactly on 1-10 with no
// rounding and no unreachable values.
//
// Goodreads is 1-5 whole stars, so the same doubling lands only on the even
// numbers — an imported library will contain no 7s or 9s until the reader
// edits them. That is a known and accepted trade (a coarser scale in is
// still better than no ratings at all), not an oversight.
const starsToTen = stars => {
  const n = parseFloat(stars);
  if (!Number.isFinite(n) || n <= 0 || n > 5) return null;
  return Math.round(n * 2);
};

// Goodreads writes its id columns Excel-safe, as ="9780441013593", so the
// raw cell is useless without stripping that wrapper. Empty ISBNs come
// through as ="" .
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
function matchRow(row, byTitle) {
  const rating = starsToTen(row.Rating);
  const name = (row.Name || '').trim();
  const year = parseInt(row.Year, 10);
  if (!name) return null;
  if (rating === null) return { name, year, status: 'unrated' };

  const candidates = byTitle.get(normalizeTitleForSearch(name)) || [];

  const base = { name, year, rating, watchedDate: row.Date || null };
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
router.post('/letterboxd/preview', requireAuth, [
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
    if (!('Name' in rows[0]) || !('Rating' in rows[0])) {
      return res.status(422).json({
        error: 'That does not look like a Letterboxd ratings export. Expected columns Name, Year and Rating — use ratings.csv from Letterboxd’s Export Your Data.',
      });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(413).json({ error: `That export has ${rows.length} rows; this importer handles up to ${MAX_ROWS} at once.` });
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
// Takes back only what the user confirmed: [{ mediaItemId, rating, watchedDate }].
// The server re-validates every field; the preview response is a suggestion,
// not something to trust on the way back in.
router.post('/letterboxd/commit', requireAuth, [
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
      const prior = existingBy[item.mediaItemId];

      if (prior) {
        await prisma.review.update({
          where: { id: prior.id },
          data: {
            rating, verdict, dateConsumed, visibility: vis, isDraft: false,
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
            rating, verdict, dateConsumed, visibility: vis,
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
// Better: the export carries ISBN13, which matches MediaItem.isbn13 exactly.
// No title+year guessing for any book that has one on both sides.
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
    isbns.length ? prisma.mediaItem.findMany({
      where: { mediaType: 'BOOK', isbn13: { in: isbns } },
      select: { id: true, title: true, releaseYear: true, slug: true, imageUrl: true, isbn13: true,
                authors: { select: { name: true } } },
    }) : [],
    prisma.mediaItem.findMany({
      where: { mediaType: 'BOOK', normalizedTitle: { in: titles } },
      select: { id: true, title: true, releaseYear: true, slug: true, imageUrl: true, normalizedTitle: true,
                authors: { select: { name: true } } },
    }),
  ]);

  const byIsbn = new Map(byIsbnRows.map(m => [m.isbn13, m]));
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

module.exports = router;
