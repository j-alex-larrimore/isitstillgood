// Bulk media importer — looks up a list of titles against the same external
// sources the admin form uses (TMDB, Google Books/Open Library, IGDB) and
// inserts them directly into the database via Prisma.
//
// Usage:
//   node scripts/bulk-import.js <file.csv|file.json> [--dry-run] [--tags="Tag One,Tag Two"]
//
// Input file formats:
//   CSV  — header row: mediaType,title,year,author,seriesName,seriesNumber,tags,genres
//          (everything but mediaType and title is optional; tags and genres
//           are semicolon-separated, e.g. "HBO;Prestige TV". genres, when
//           given, overrides whatever the lookup returns — useful for
//           pinning exact genre strings instead of Google Books/TMDB's own
//           (often noisy) category text)
//   JSON — array of objects with the same fields:
//          [{ "mediaType": "MOVIE", "title": "Sinners", "year": 2025 }, ...]
//
// mediaType must be one of MOVIE, BOOK, TV_SHOW, VIDEO_GAME.
// TV_SHOW rows create the parent show only (seasons must still be added
// individually through the admin UI, since each needs its own cast diff).
//
// Requires TMDB_READ_ACCESS_TOKEN, GOOGLE_BOOKS_API_KEY, IGDB_CLIENT_ID and
// IGDB_CLIENT_SECRET in .env — copy these from Railway's Variables tab.
// Safe to re-run: existing items (matched by external ID, then by title)
// are skipped rather than duplicated.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, normalizeTags, normalizeGenres, normalizeBookGenres, findDuplicate } = require('../src/lib/mediaHelpers');
const {
  searchTmdb, getTmdbDetail,
  searchGoogleBooks, getGoogleBooksDetail,
  searchOpenLibrary, getOpenLibraryDetail,
  searchIgdb,
} = require('../src/services/mediaLookup');

const VALID_TYPES = ['MOVIE', 'BOOK', 'TV_SHOW', 'VIDEO_GAME'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Input parsing ─────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { fields.push(cur); cur = ''; }
    else cur += c;
  }
  fields.push(cur);
  return fields.map(f => f.trim());
}

function loadRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(raw);
  }
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length);
  const header = parseCsvLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    header.forEach((key, i) => { row[key] = values[i]; });
    return row;
  });
}

function normalizeRow(row) {
  return {
    mediaType:    String(row.mediaType || '').trim().toUpperCase(),
    title:        String(row.title || '').trim(),
    year:         row.year ? parseInt(row.year) : null,
    author:       row.author ? String(row.author).trim() : null,
    seriesName:   row.seriesName ? String(row.seriesName).trim() : null,
    seriesNumber: row.seriesNumber ? parseInt(row.seriesNumber) : null,
    tags: Array.isArray(row.tags)
      ? row.tags
      : (row.tags ? String(row.tags).split(';').map(t => t.trim()).filter(Boolean) : []),
    // Optional override — when given, replaces whatever genres the lookup returns
    genres: Array.isArray(row.genres)
      ? row.genres
      : (row.genres ? String(row.genres).split(';').map(g => g.trim()).filter(Boolean) : []),
  };
}

// ─── Best-match selection ─────────────────────────────────────────────────
// Popular/heavily-republished titles return a lot of noise in search results —
// translations, study guides, abridged/split editions, "Title by Author"
// listings. Prefer candidates whose title exactly matches (after stripping
// trailing "by <author>" and bracketed/parenthetical annotations) before
// falling back to year, then to the first (most relevant) result.
function normalizeTitleForMatch(t) {
  return (t || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/\s+by\s+[a-z.\s]+$/i, '')
    .replace(/[.,:;!?'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickBestMatch(candidates, year, expectedTitle) {
  if (!candidates.length) return null;
  let pool = candidates;
  if (expectedTitle) {
    const normExpected = normalizeTitleForMatch(expectedTitle);
    const exactTitleMatches = candidates.filter(c => normalizeTitleForMatch(c.title) === normExpected);
    if (exactTitleMatches.length) pool = exactTitleMatches;
  }
  if (year) {
    const yearMatch = pool.find(c => parseInt(c.releaseYear) === year);
    if (yearMatch) return yearMatch;
  }
  return pool[0];
}

// Books specifically attract study guides, teacher's editions, and
// companion volumes that share the real book's title. Score candidates so
// the actual novel — single expected author, full page count — sorts first,
// before title/year matching narrows the pool.
//
// Also attracts omnibus/collection editions ("The Complete Broken Empire
// Trilogy", "The Silo Series Collection") — these have high page counts
// that would otherwise score *well* under the check above, exactly
// backwards from what we want. Per explicit direction: only original
// individual books should be entered, never bundled/omnibus editions.
function looksLikeOmnibus(title) {
  const t = title || '';
  if (/\b(omnibus|collection|box(ed)?\s*set|bundle)\b/i.test(t)) return true;
  // "complete" and "trilogy/series/saga/duology/quartet" often aren't
  // adjacent ("Complete Broken Empire Trilogy" has two words between them),
  // so check both appear anywhere rather than requiring \s+ between them.
  if (/\bcomplete\b/i.test(t) && /\b(trilogy|series|saga|duology|quartet)\b/i.test(t)) return true;
  // "Books 4-6", "Books 1 and 2", "Vol 2: Books 4 - 6", "Volumes 1-3"
  if (/\b(books?|vol(ume)?s?)\s*\.?\s*\d+\s*(-|to|and)\s*\d+/i.test(t)) return true;
  // Omnibus titles frequently list every constituent book after a colon,
  // comma-separated ("...Trilogy: Prince of Thorns, King of Thorns, Emperor
  // of Thorns") — 2+ commas after the colon is a strong standalone signal.
  const afterColon = t.split(':')[1];
  if (afterColon && (afterColon.match(/,/g) || []).length >= 2) return true;
  return false;
}
function scoreBookCandidate(c, expectedAuthor) {
  let score = 0;
  const authors = c.authors || [];
  if (expectedAuthor) {
    const lastName = expectedAuthor.trim().split(/\s+/).pop().toLowerCase();
    const hasExpectedAuthor = authors.some(a => a.toLowerCase().includes(lastName));
    if (hasExpectedAuthor && authors.length === 1) score += 2;
    else if (hasExpectedAuthor) score += 1;
  }
  if (typeof c.pageCount === 'number') {
    if (c.pageCount >= 150) score += 2;
    else if (c.pageCount >= 50) score += 1;
  }
  if (looksLikeOmnibus(c.title)) score -= 10;
  return score;
}

// ─── Per-type lookup ───────────────────────────────────────────────────────
async function lookupMovieOrTv(row) {
  const tmdbType = row.mediaType === 'TV_SHOW' ? 'tv' : 'movie';
  const candidates = await searchTmdb(row.title, tmdbType, row.year);
  const match = pickBestMatch(candidates, row.year, row.title);
  if (!match) return null;
  const detail = await getTmdbDetail(match.tmdbId, tmdbType);
  return {
    tmdbId:      detail.tmdbId,
    title:       detail.title,
    releaseYear: detail.releaseYear ? parseInt(detail.releaseYear) : null,
    description: detail.description,
    imageUrl:    detail.imageUrl,
    genres:      normalizeGenres(detail.genres || []),
    directors:   detail.directors || [],
    cast:        detail.cast || [],
    seasons:     detail.seasons || null,
    tmdbRating:  detail.tmdbRating || null,
  };
}

async function lookupBook(row) {
  let candidates = [];
  if (process.env.GOOGLE_BOOKS_API_KEY) {
    candidates = await searchGoogleBooks(row.title, row.author, row.year);
    candidates = [...candidates].sort((a, b) => scoreBookCandidate(b, row.author) - scoreBookCandidate(a, row.author));
  }
  if (candidates.length) {
    // Don't let year steer selection here — candidates are already sorted by
    // quality (author match + page count), and a low-quality edition (reader,
    // study guide) can coincidentally carry the "right" year metadata while a
    // clean, full-text edition carries a later reprint year. The caller's
    // row.year (when given) is trusted as the true release year regardless
    // of which edition record we end up pulling title/genres/cover from.
    const match = pickBestMatch(candidates, null, row.title);
    const detail = await getGoogleBooksDetail(match.googleBooksId);
    return {
      goodreadsId: null, // Google Books results aren't stored under goodreadsId
      title:       detail.title,
      releaseYear: detail.releaseYear,
      description: detail.description,
      imageUrl:    detail.imageUrl,
      genres:      normalizeBookGenres(detail.genres || []),
      authors:     detail.authors || [],
    };
  }

  // Fall back to Open Library — no API key required
  candidates = await searchOpenLibrary(row.title, row.year, row.author);
  candidates = [...candidates].sort((a, b) => scoreBookCandidate(b, row.author) - scoreBookCandidate(a, row.author));
  const match = pickBestMatch(candidates, null, row.title);
  if (!match) return null;
  const detail = await getOpenLibraryDetail(match.openLibraryId, row.year);
  return {
    goodreadsId: detail.openLibraryId,
    title:       detail.title,
    releaseYear: detail.releaseYear,
    description: detail.description,
    imageUrl:    detail.imageUrl,
    genres:      normalizeBookGenres(detail.genres || []),
    authors:     detail.authors || [],
  };
}

async function lookupGame(row) {
  const candidates = await searchIgdb(row.title, row.year);
  const match = pickBestMatch(candidates, row.year, row.title);
  if (!match) return null;
  return {
    openCriticId:    match.igdbId,
    title:           match.title,
    releaseYear:     match.releaseYear,
    description:     match.description,
    imageUrl:        match.imageUrl,
    genres:          normalizeGenres(match.genres || []),
    openCriticScore: match.rating || null,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tagsArg = args.find(a => a.startsWith('--tags='));
  const globalTags = tagsArg ? tagsArg.slice('--tags='.length).split(',').map(t => t.trim()).filter(Boolean) : [];
  const filePath = args.find(a => !a.startsWith('--'));

  if (!filePath) {
    console.error('Usage: node scripts/bulk-import.js <file.csv|file.json> [--dry-run] [--tags="Tag One,Tag Two"]');
    process.exit(1);
  }

  const rows = loadRows(path.resolve(filePath)).map(normalizeRow);
  console.log(`Loaded ${rows.length} row(s) from ${filePath}${dryRun ? ' (dry run — no writes)' : ''}\n`);

  const results = { added: [], skipped: [], failed: [] };

  for (const row of rows) {
    if (!VALID_TYPES.includes(row.mediaType)) {
      console.log(`✗ "${row.title}" — invalid mediaType "${row.mediaType}"`);
      results.failed.push({ title: row.title, error: `invalid mediaType "${row.mediaType}"` });
      continue;
    }
    if (!row.title) {
      console.log('✗ (blank row) — title is required');
      results.failed.push({ title: '(blank)', error: 'title is required' });
      continue;
    }

    try {
      let data;
      if (row.mediaType === 'MOVIE' || row.mediaType === 'TV_SHOW') {
        data = await lookupMovieOrTv(row);
      } else if (row.mediaType === 'BOOK') {
        data = await lookupBook(row);
      } else {
        data = await lookupGame(row);
      }

      if (!data) {
        console.log(`⚠ "${row.title}" — no match found, skipping`);
        results.skipped.push(row.title);
        await sleep(1100);
        continue;
      }

      const duplicate = await findDuplicate({
        title:         data.title,
        mediaType:     row.mediaType,
        tmdbId:        data.tmdbId,
        igdbId:        data.openCriticId,
        openLibraryId: data.goodreadsId,
        releaseYear:   data.releaseYear,
        authors:       data.authors,
      });
      if (duplicate) {
        console.log(`⚠ "${data.title}" — already in database (${duplicate.slug}), skipping`);
        results.skipped.push(data.title);
        await sleep(1100);
        continue;
      }

      const tags = normalizeTags([...globalTags, ...row.tags]);
      // Row-level genres override whatever the lookup returned — lets a
      // caller pin exact genre strings instead of relying on Google Books/
      // TMDB/IGDB's own (often noisy) category text.
      const genres = row.genres.length ? row.genres : (data.genres || []);
      // For books specifically, trust the caller's year over the matched
      // edition's metadata — Google Books/Open Library editions are often
      // reprints, and the row's year is usually the true original publication
      // year (lookupBook already ignores year when picking a candidate, for
      // the same reason).
      const releaseYear = (row.mediaType === 'BOOK' && row.year) ? row.year : data.releaseYear;

      if (dryRun) {
        console.log(`+ "${data.title}" (${row.mediaType}, ${releaseYear || 'year unknown'}) — would be added [${genres.join(', ')}]`);
        results.added.push(data.title);
        await sleep(1100);
        continue;
      }

      const slug = await uniqueSlug(slugify(data.title, releaseYear));
      await prisma.mediaItem.create({
        data: {
          mediaType:       row.mediaType,
          title:           data.title,
          slug,
          releaseYear,
          verified:        false, // queues for admin review before showing up publicly
          description:     data.description || null,
          imageUrl:        data.imageUrl || null,
          genres,
          tags,
          tmdbId:          data.tmdbId || null,
          tmdbRating:      data.tmdbRating || null,
          goodreadsId:     data.goodreadsId || null,
          openCriticId:    data.openCriticId || null,
          openCriticScore: data.openCriticScore || null,
          seasons:         data.seasons || null,
          seriesName:      row.mediaType === 'BOOK' ? row.seriesName : null,
          seriesNumber:    row.mediaType === 'BOOK' ? row.seriesNumber : null,
          directors:       await connectPersons(data.directors || []),
          cast:            await connectPersons(data.cast || []),
          authors:         await connectPersons(data.authors || []),
        },
      });
      console.log(`✓ "${data.title}" (${row.mediaType}, ${releaseYear || 'year unknown'}) — added`);
      results.added.push(data.title);
    } catch (err) {
      console.log(`✗ "${row.title}" — ${err.message}`);
      results.failed.push({ title: row.title, error: err.message });
    }

    await sleep(1100); // be polite to external APIs, especially IGDB/TMDB rate limits
  }

  console.log(`\nDone. Added ${results.added.length}, skipped ${results.skipped.length}, failed ${results.failed.length}.`);
  if (results.failed.length) {
    console.log('\nFailures:');
    for (const f of results.failed) console.log(`  - ${f.title}: ${f.error}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
