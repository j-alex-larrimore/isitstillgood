// One-off/rerunnable audit: two related data-quality passes over BOOK rows.
//
// 1. Wrong-language or missing covers — Open Library's cover_i field is
//    picked from an aggregated "work" record spanning every translated
//    edition, with no language filtering (root cause documented next to
//    searchOpenLibrary in src/services/mediaLookup.js). A book with an
//    Open Library cover is only actually AT RISK if its Open Library work
//    genuinely has more than one language edition — most never-translated
//    indie titles aren't, so this triage step (free, no API key) narrows
//    1,000+ candidates down to the much smaller set worth spending Google
//    Books quota on. A book with NO cover at all (several of this
//    session's manual inserts never got one set) always counts as at-risk,
//    no triage needed — there's nothing to check language on.
// 2. Missing/empty descriptions — filled in from the same Google Books
//    lookup when found.
//
// For both, prefer the candidate edition with the highest page count among
// real English matches — abridged/study-guide/excerpt editions tend to have
// anomalously low page counts, so this favors the standard, widely-known
// edition's cover and description over an obscure alternate.
//
// Self-resuming by construction: once a book gets a non-Open-Library cover,
// or its description is filled in, it naturally drops out of the query on
// the next run — no checkpoint file needed. Safe to re-run whenever Google
// Books quota is available again.
//
// Usage: node scripts/audit-book-covers.js [--triage-only] [--limit=N]

require('dotenv').config();
const prisma = require('../src/lib/prisma');

const args = process.argv.slice(2);
const triageOnly = args.includes('--triage-only');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalize(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanDescription(raw) {
  if (!raw) return null;
  return raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() || null;
}

async function getOpenLibraryLanguages(title, author) {
  let url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=5&fields=title,language`;
  if (author) url += `&author=${encodeURIComponent(author)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const target = normalize(title);
  const match = (json.docs || []).find(d => normalize(d.title) === target) || json.docs?.[0];
  return match?.language || null;
}

// Raw network-level failures (ECONNRESET, DNS blips, etc.) throw rather than
// returning a response — unlike a non-200 HTTP status, which was already
// handled below. Left uncaught, one of these previously killed the whole
// script instead of just skipping that one book, losing all remaining
// progress for the run (confirmed live: an ECONNRESET on "Rising Sun" took
// down an otherwise-healthy run partway through). Treated the same as a 503
// so the self-resuming design can actually do its job book-by-book.
async function getVolumeDetail(id) {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes/${id}?key=${key}`);
    if (!res.ok) return { status: res.status, info: null };
    const item = await res.json();
    return { status: 200, info: item.volumeInfo || {} };
  } catch (e) {
    return { status: 503, info: null };
  }
}

async function searchGoogleBooksRaw(title, author) {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  let q = `intitle:${title}`;
  if (author) q += `+inauthor:${author}`;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=15&key=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: res.status, items: [] };
    const json = await res.json();
    return { status: 200, items: json.items || [] };
  } catch (e) {
    return { status: 503, items: [] };
  }
}

// Among English-language candidates matching this title, pick the one most
// likely to be the standard/widely-known edition — highest page count is a
// reasonable proxy since abridged/study-guide/excerpt editions tend to be
// anomalously short.
async function pickBestEnglishEdition(candidates) {
  const scored = [];
  for (const c of candidates.slice(0, 8)) {
    const { status, info } = await getVolumeDetail(c.id);
    await sleep(300);
    if (status === 429) return { quotaHit: true, picked: null };
    if (status !== 200 || info.language !== 'en') continue;
    scored.push({ id: c.id, info });
  }
  if (!scored.length) return { quotaHit: false, picked: null };
  scored.sort((a, b) => (b.info.pageCount || 0) - (a.info.pageCount || 0));
  return { quotaHit: false, picked: scored[0].info };
}

// Google Books volume IDs ending in "CAAJ" are catalog/metadata-only records
// (no real digitized preview) — the API still returns an imageLinks.thumbnail
// URL for them, but it 404s. Treat these exactly like a missing cover.
function hasDeadGoogleId(imageUrl) {
  if (!imageUrl) return false;
  const match = imageUrl.match(/[?&]id=([^&]+)/);
  return !!match && match[1].endsWith('CAAJ');
}

// Open Library's own "-1" cover id is its explicit sentinel for "no image
// exists" — resolves to a broken/placeholder image regardless of language,
// so it must always count as missing rather than going through the
// language-risk triage (a single-language English work with a -1 cover
// would otherwise be wrongly classified as "not at risk").
function isDeadOpenLibraryId(imageUrl) {
  return !!imageUrl && /\/id\/-1-/.test(imageUrl);
}

async function main() {
  const books = await prisma.mediaItem.findMany({
    where: {
      mediaType: 'BOOK',
      OR: [
        { imageUrl: { contains: 'covers.openlibrary.org' } },
        { imageUrl: { contains: 'CAAJ&' } },
        { imageUrl: null },
        { description: null },
        { description: '' },
      ],
    },
    select: { id: true, title: true, releaseYear: true, imageUrl: true, description: true, authors: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
    take: limit || undefined,
  });
  console.log(`Scanning ${books.length} book(s) needing a cover and/or description check...\n`);

  let coverAtRisk = 0, missingDesc = 0, coverFixed = 0, descFixed = 0, noConfidentFix = 0, quotaHit = false;

  for (const book of books) {
    const authorName = book.authors[0]?.name || null;
    const hasOLCover = book.imageUrl?.includes('covers.openlibrary.org') && !isDeadOpenLibraryId(book.imageUrl);
    const hasNoCover = !book.imageUrl || hasDeadGoogleId(book.imageUrl) || isDeadOpenLibraryId(book.imageUrl);
    const needsDesc = !book.description;

    let coverIsRisk = hasNoCover; // nothing to check language on — always worth a lookup
    if (hasOLCover) {
      let languages;
      try {
        languages = await getOpenLibraryLanguages(book.title, authorName);
      } catch (e) {
        languages = null;
      }
      await sleep(250);
      coverIsRisk = (Array.isArray(languages) && languages.length > 1) ||
                    (Array.isArray(languages) && languages.length >= 1 && !languages.includes('eng'));
    }

    if (!coverIsRisk && !needsDesc) continue; // nothing to do for this book

    if (coverIsRisk) { coverAtRisk++; console.log(`COVER ${hasNoCover ? 'MISSING' : 'AT RISK'}: "${book.title}"`); }
    if (needsDesc)   { missingDesc++; console.log(`MISSING DESCRIPTION: "${book.title}"`); }

    if (triageOnly || quotaHit) continue;

    const { status, items } = await searchGoogleBooksRaw(book.title, authorName);
    await sleep(400);
    if (status === 429) {
      console.log('  Google Books quota exhausted — switching to triage-only for the rest of this run.');
      quotaHit = true;
      continue;
    }
    if (status !== 200) {
      console.log(`  Google Books fetch failed (status ${status}), skipping`);
      noConfidentFix++;
      continue;
    }

    const target = normalize(book.title);
    const candidates = items.filter(it => {
      const t = normalize(it.volumeInfo?.title || '');
      return t === target || t.startsWith(target);
    });

    const { quotaHit: hitDuringPick, picked } = await pickBestEnglishEdition(candidates);
    if (hitDuringPick) {
      console.log('  Google Books quota exhausted — switching to triage-only for the rest of this run.');
      quotaHit = true;
      continue;
    }
    if (!picked) {
      console.log('  no confident English match found — leaving as-is');
      noConfidentFix++;
      continue;
    }

    const data = {};
    if (coverIsRisk && picked.imageLinks?.thumbnail) {
      data.imageUrl = picked.imageLinks.thumbnail.replace('http://', 'https://').replace('zoom=1', 'zoom=3');
    }
    if (needsDesc && picked.description) {
      data.description = cleanDescription(picked.description);
    }
    if (Object.keys(data).length) {
      await prisma.mediaItem.update({ where: { id: book.id }, data });
      if (data.imageUrl) { console.log(`  FIXED COVER -> ${data.imageUrl}`); coverFixed++; }
      if (data.description) { console.log(`  FILLED DESCRIPTION`); descFixed++; }
    } else {
      noConfidentFix++;
    }
  }

  console.log(`\nDone. Scanned ${books.length}, cover-at-risk ${coverAtRisk}, missing-desc ${missingDesc}, covers fixed ${coverFixed}, descriptions filled ${descFixed}, no confident fix ${noConfidentFix}.`);
  if (quotaHit) console.log('Google Books quota ran out partway through — re-run later to continue (already-fixed books drop out of the query automatically).');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
