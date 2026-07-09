// Bulk media importer — looks up a list of titles against the same external
// sources the admin form uses (TMDB, Google Books/Open Library, IGDB) and
// inserts them directly into the database via Prisma.
//
// Usage:
//   node scripts/bulk-import.js <file.csv|file.json> [--dry-run] [--tags="Tag One,Tag Two"]
//
// Input file formats:
//   CSV  — header row: mediaType,title,year,author,seriesName,seriesNumber,tags
//          (year, author, seriesName, seriesNumber, tags are all optional;
//           tags is semicolon-separated, e.g. "HBO;Prestige TV")
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
const { slugify, uniqueSlug, connectPersons, normalizeTags, normalizeGenres, findDuplicate } = require('../src/lib/mediaHelpers');
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
  };
}

// ─── Best-match selection ─────────────────────────────────────────────────
// When a year is given, prefer the candidate whose releaseYear matches it;
// otherwise fall back to the first (most relevant) search result.
function pickBestMatch(candidates, year) {
  if (!candidates.length) return null;
  if (year) {
    const exact = candidates.find(c => parseInt(c.releaseYear) === year);
    if (exact) return exact;
  }
  return candidates[0];
}

// ─── Per-type lookup ───────────────────────────────────────────────────────
async function lookupMovieOrTv(row) {
  const tmdbType = row.mediaType === 'TV_SHOW' ? 'tv' : 'movie';
  const candidates = await searchTmdb(row.title, tmdbType, row.year);
  const match = pickBestMatch(candidates, row.year);
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
  }
  if (candidates.length) {
    const match = pickBestMatch(candidates, row.year);
    const detail = await getGoogleBooksDetail(match.googleBooksId);
    return {
      goodreadsId: null, // Google Books results aren't stored under goodreadsId
      title:       detail.title,
      releaseYear: detail.releaseYear,
      description: detail.description,
      imageUrl:    detail.imageUrl,
      genres:      normalizeGenres(detail.genres || []),
      authors:     detail.authors || [],
    };
  }

  // Fall back to Open Library — no API key required
  candidates = await searchOpenLibrary(row.title, row.year, row.author);
  const match = pickBestMatch(candidates, row.year);
  if (!match) return null;
  const detail = await getOpenLibraryDetail(match.openLibraryId, row.year);
  return {
    goodreadsId: detail.openLibraryId,
    title:       detail.title,
    releaseYear: detail.releaseYear,
    description: detail.description,
    imageUrl:    detail.imageUrl,
    genres:      normalizeGenres(detail.genres || []),
    authors:     detail.authors || [],
  };
}

async function lookupGame(row) {
  const candidates = await searchIgdb(row.title, row.year);
  const match = pickBestMatch(candidates, row.year);
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
        await sleep(300);
        continue;
      }

      const duplicate = await findDuplicate({
        title:         data.title,
        mediaType:     row.mediaType,
        tmdbId:        data.tmdbId,
        igdbId:        data.openCriticId,
        openLibraryId: data.goodreadsId,
      });
      if (duplicate) {
        console.log(`⚠ "${data.title}" — already in database (${duplicate.slug}), skipping`);
        results.skipped.push(data.title);
        await sleep(300);
        continue;
      }

      const tags = normalizeTags([...globalTags, ...row.tags]);

      if (dryRun) {
        console.log(`+ "${data.title}" (${row.mediaType}, ${data.releaseYear || 'year unknown'}) — would be added`);
        results.added.push(data.title);
        await sleep(300);
        continue;
      }

      const slug = await uniqueSlug(slugify(data.title, data.releaseYear));
      await prisma.mediaItem.create({
        data: {
          mediaType:       row.mediaType,
          title:           data.title,
          slug,
          releaseYear:     data.releaseYear,
          description:     data.description || null,
          imageUrl:        data.imageUrl || null,
          genres:          data.genres || [],
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
      console.log(`✓ "${data.title}" (${row.mediaType}, ${data.releaseYear || 'year unknown'}) — added`);
      results.added.push(data.title);
    } catch (err) {
      console.log(`✗ "${row.title}" — ${err.message}`);
      results.failed.push({ title: row.title, error: err.message });
    }

    await sleep(300); // be polite to external APIs, especially IGDB/TMDB rate limits
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
