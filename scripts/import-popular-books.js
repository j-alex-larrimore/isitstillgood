// Adds the most-read books we don't have yet, in popularity order.
//
//   node scripts/import-popular-books.js --dry-run            (always do this first)
//   node scripts/import-popular-books.js --add=500
//   node scripts/import-popular-books.js --add=500 --queue    (hold for admin review)
//
// Why this exists: matching a Goodreads or StoryGraph import has two failure
// modes, and multi-ISBN matching only fixed one of them. The other is simply
// not stocking the book — a 5,536-book catalogue misses Dune. No amount of
// identifier work helps there; the catalogue has to grow, most-read first,
// because that is what a real reader's export is full of.
//
// Ranking comes from Open Library's `sort=readinglog` — how many OL users have
// the work on a shelf. It is the only free, sortable, whole-catalogue
// popularity signal available: Goodreads has no API to rank by, and Google
// Books exposes ratingsCount per volume but offers no way to discover by it.
// Restricted to language=eng; without that the list is full of titles no
// reader of this site would search for.
//
// The tail falls away fast — 63,538 shelvings at rank 1, 964 at rank 500, 153
// at rank 5,000 — so the value is concentrated in the first few thousand and
// --min-readinglog stops it wandering into the long tail.
//
// Publishes by default (verified: true), like the weekly sync scripts and
// unlike bulk-import.js. Queuing a thousand books for a manual review that
// will never happen just hides them. Pass --queue to get the old behaviour.
// Run scripts/audit-cover-mismatches.js afterwards — a popularity list is a
// list of titles with many editions, which is exactly where covers go wrong.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');
const {
  slugify, uniqueSlug, connectPersons, normalizeTags, normalizeBookGenres,
  findDuplicate, normalizeTitleForSearch,
} = require('../src/lib/mediaHelpers');
const { getOpenLibraryDetail } = require('../src/services/mediaLookup');

const UA = 'isitstillgood-catalogue/1.0 (j.alex.larrimore@gmail.com)';
const PAGE = 100;
const SEARCH_PACE_MS = 400;   // between search pages
const DETAIL_PACE_MS = 450;   // between per-book detail fetches
const CHECKPOINT = path.join(__dirname, '_popular-books-checkpoint.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const QUEUE = args.includes('--queue');
const num = (flag, dflt) => {
  const v = parseInt((args.find(a => a.startsWith(`--${flag}=`)) || '').split('=')[1], 10);
  return Number.isFinite(v) ? v : dflt;
};
const ADD_TARGET = num('add', 250);
const MAX_SCAN = num('max-scan', 20000);
const MIN_READINGLOG = num('min-readinglog', 100);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = s => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();
function isbn10to13(raw) {
  const s = digits(raw);
  if (s.length !== 10) return null;
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}
function normalizeIsbn(raw) {
  const s = digits(raw);
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10) return isbn10to13(s);
  return null;
}

// Surname-ish tokens, same shape the Goodreads importer uses, so "Richard
// Adams" and "Adams, Richard" agree and a shared forename alone doesn't match.
const nameTokens = names => new Set(
  names.flatMap(n => normalizeTitleForSearch(String(n || '')).split(' ')).filter(t => t.length > 2)
);

const loadCheckpoint = () => {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); }
  catch { return { offset: 0, seen: [] }; }
};
const saveCheckpoint = c => fs.writeFileSync(CHECKPOINT, JSON.stringify(c, null, 0));

// Open Library's `language=eng` filters on "has an English edition", not on
// the language of the work's own title, so the ranked list hands back
// "O Alquimista", "Le petit prince", "L'étranger" and
// "Преступление и наказание". Importing those defeats the purpose: a reader's
// export says "The Alchemist", and our own browse would show a title nobody
// searches for.
//
// The fix is to take the most common title among the work's English editions —
// O Alquimista -> The Alchemist (46 of 60), Преступление и наказание ->
// Crime and Punishment (82 of 153). Applied only when the work's own title is
// absent from its English editions, so natively-English books keep the title
// they already have rather than being renamed by a stray variant.
//
// Note OL frequently stores these article-stripped ("Stranger", not "The
// Stranger"). That is cosmetic here: normalizeTitleForSearch drops leading
// articles on both sides, so matching an import is unaffected.
// Returns { title, earliestEdition } from one editions fetch — the title fix
// above and the year cross-check below both need the same response, so they
// share a request rather than asking twice.
async function editionFacts(workId, workTitle) {
  try {
    const r = await fetch(`https://openlibrary.org/works/${workId}/editions.json?limit=200`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!r.ok) return {};
    const j = await r.json();
    const entries = j.entries || [];

    const years = entries
      .map(e => { const m = String(e.publish_date || '').match(/\d{4}/); return m ? +m[0] : null; })
      .filter(y => y && y >= 1400);
    const earliestEdition = years.length ? Math.min(...years) : null;

    const eng = entries.filter(e => (e.languages || []).some(l => /\/eng$/.test(l.key || '')));
    if (!eng.length) return { earliestEdition };

    const counts = new Map();
    for (const e of eng) {
      const t = (e.title || '').trim();
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
    if (!counts.size) return { earliestEdition };

    const want = normalizeTitleForSearch(workTitle);
    for (const t of counts.keys()) {
      if (normalizeTitleForSearch(t) === want) return { earliestEdition }; // already English
    }
    return { title: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0], earliestEdition };
  } catch { return {}; }
}

// Open Library's first_publish_year is unreliable at the edges — the ranked
// list offered Lolita as 1777. A wrong year is not cosmetic: slugify() bakes
// it into the URL and slugs are never regenerated, so it would be wrong
// forever. Anything implausible is dropped rather than guessed at; a missing
// year is recoverable, a wrong permanent slug is not.
const saneYear = y => (Number.isFinite(y) && y >= 1400 && y <= new Date().getFullYear() + 2) ? y : null;

async function searchPage(offset) {
  const q = new URLSearchParams({
    q: '*:*', sort: 'readinglog', language: 'eng',
    limit: String(PAGE), offset: String(offset),
    fields: 'key,title,author_name,first_publish_year,readinglog_count,ratings_count,isbn,cover_i',
  });
  const r = await fetch(`https://openlibrary.org/search.json?${q}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// An in-memory index of what we already hold. Built once: 5,500 books is small,
// and checking each candidate with its own query would be thousands of
// round trips against a database this project has already knocked over once.
async function buildHaveIndex() {
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK' },
    select: { normalizedTitle: true, isbn13: true, isbns: true, goodreadsId: true,
              authors: { select: { name: true } } },
  });
  const byIsbn = new Set();
  const byWork = new Set();
  const byTitle = new Map();
  for (const b of books) {
    for (const i of [...(b.isbns || []), b.isbn13].filter(Boolean)) byIsbn.add(i);
    if (b.goodreadsId) byWork.add(b.goodreadsId);
    const t = b.normalizedTitle || normalizeTitleForSearch(b.title || '');
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(nameTokens((b.authors || []).map(a => a.name)));
  }
  return { byIsbn, byWork, byTitle, count: books.length };
}

function alreadyHave(idx, cand) {
  if (cand.workId && idx.byWork.has(cand.workId)) return 'work id';
  for (const i of cand.isbns) if (idx.byIsbn.has(i)) return 'isbn';
  const t = normalizeTitleForSearch(cand.title);
  const rows = idx.byTitle.get(t);
  if (rows) {
    const want = nameTokens(cand.authors);
    // Title alone isn't enough — distinct works share titles constantly. An
    // author token has to agree, or a title with no author on either side.
    for (const have of rows) {
      if (!want.size || !have.size) return 'title';
      for (const tok of want) if (have.has(tok)) return 'title+author';
    }
  }
  return null;
}

(async () => {
  const cp = loadCheckpoint();
  const seen = new Set(cp.seen || []);
  const idx = await buildHaveIndex();

  console.log(`catalogue: ${idx.count} books · ${idx.byIsbn.size} known ISBNs · ${idx.byWork.size} known OL works`);
  console.log(`target: add up to ${ADD_TARGET} · scan to rank ${MAX_SCAN} · floor ${MIN_READINGLOG} shelvings`);
  console.log(`mode: ${DRY ? 'DRY RUN (no writes)' : (QUEUE ? 'WRITE, queued for review' : 'WRITE, published')}`);
  console.log(`resuming from rank ${cp.offset}\n`);

  let added = 0, scanned = 0, had = 0, skippedThin = 0, failed = 0, renamed = 0, noYear = 0, consecutiveFailures = 0;
  const hadBy = {};
  let offset = cp.offset;

  outer:
  while (offset < MAX_SCAN && added < ADD_TARGET) {
    const page = await searchPage(offset);
    await sleep(SEARCH_PACE_MS);
    if (!page || !(page.docs || []).length) {
      console.log(`\nno more results at rank ${offset}`);
      break;
    }

    for (const d of page.docs) {
      scanned++;
      const rl = d.readinglog_count || 0;
      if (rl < MIN_READINGLOG) {
        console.log(`\nreached the popularity floor (${rl} < ${MIN_READINGLOG}) at rank ${offset + page.docs.indexOf(d)}`);
        break outer;
      }
      const workId = String(d.key || '').split('/').pop();
      if (!workId || seen.has(workId)) continue;
      seen.add(workId);

      const cand = {
        workId,
        title: (d.title || '').trim(),
        authors: d.author_name || [],
        year: d.first_publish_year || null,
        isbns: [...new Set((d.isbn || []).map(normalizeIsbn).filter(Boolean))],
        readinglog: rl,
      };
      if (!cand.title) continue;

      const have = alreadyHave(idx, cand);
      if (have) { had++; hadBy[have] = (hadBy[have] || 0) + 1; continue; }

      // Detail fetch only for genuine candidates — this is the expensive call.
      let detail = null;
      try {
        detail = await getOpenLibraryDetail(workId, cand.year);
      } catch (err) {
        failed++;
        await sleep(DETAIL_PACE_MS);
        continue;
      }
      await sleep(DETAIL_PACE_MS);

      let title = (detail.title || cand.title).trim();
      const authors = detail.authors?.length ? detail.authors : cand.authors;
      const facts = await editionFacts(workId, title);
      await sleep(DETAIL_PACE_MS);

      const rawYear = detail.releaseYear || cand.year || null;
      // A first-publication year more than a century before the oldest edition
      // anyone has catalogued is a data error, not a long out-of-print classic.
      // Open Library offered Lolita as 1777 against editions starting in the
      // 1950s. Dropped rather than guessed: a null year is recoverable, but
      // slugify() bakes the year into a slug that is never regenerated.
      const impossible = rawYear && facts.earliestEdition && (facts.earliestEdition - rawYear) > 100;
      const releaseYear = impossible ? null : saneYear(rawYear);
      if (rawYear && !releaseYear) {
        noYear++;
        if (DRY) console.log(`    ↳ year ${rawYear} dropped (oldest edition ${facts.earliestEdition || '?'})`);
      }

      if (facts.title) {
        renamed++;
        if (DRY) console.log(`    ↳ "${title}" → "${facts.title}"`);
        title = facts.title;
      }
      const english = facts.title;
      // Re-check now that we know the English title: the catalogue may well
      // already hold "The Alchemist" while the ranked list offered the
      // Portuguese one, and the title index was checked against the wrong name.
      const afterRename = alreadyHave(idx, { ...cand, title, workId: null });
      if (english && afterRename) { had++; hadBy[afterRename] = (hadBy[afterRename] || 0) + 1; continue; }

      // A book with no author and no cover is almost always an Open Library
      // junk record — a scanned pamphlet or a duplicate stub. Not worth a row.
      if (!authors.length || !detail.imageUrl) { skippedThin++; continue; }

      // Final guard against the in-memory index being stale or too coarse:
      // the same check the admin UI and bulk-import run before every insert.
      const dupe = await findDuplicate({
        title, mediaType: 'BOOK', openLibraryId: workId, releaseYear, authors,
      });
      if (dupe) { had++; hadBy['findDuplicate'] = (hadBy['findDuplicate'] || 0) + 1; continue; }

      const genres = normalizeBookGenres(detail.genres || []);
      const isbns = cand.isbns;

      if (DRY) {
        console.log(`+ ${String(rl).padStart(6)} rl · ${title.slice(0, 44).padEnd(45)} ${(authors[0] || '').slice(0, 22).padEnd(23)} ${releaseYear || '----'} · ${isbns.length} isbns · [${genres.slice(0, 3).join(', ')}]`);
        added++;
        continue;
      }

      try {
        const slug = await uniqueSlug(slugify(title, releaseYear));
        await prisma.mediaItem.create({
          data: {
            mediaType:       'BOOK',
            title,
            normalizedTitle: normalizeTitleForSearch(title),
            slug,
            releaseYear,
            // See the header: published by default, like the weekly syncs.
            verified:        !QUEUE,
            description:     detail.description || null,
            imageUrl:        detail.imageUrl || null,
            genres,
            tags:            normalizeTags([]),
            goodreadsId:     workId,
            // Populated at insert so a new book is matchable by any edition
            // immediately, without waiting on backfill-book-isbns.js.
            isbns,
            isbn13:          isbns[0] || null,
            authors:         await connectPersons(authors),
          },
        });
        added++;
        // Keep the index current so later pages can't re-add the same work.
        idx.byWork.add(workId);
        for (const i of isbns) idx.byIsbn.add(i);
        const t = normalizeTitleForSearch(title);
        if (!idx.byTitle.has(t)) idx.byTitle.set(t, []);
        idx.byTitle.get(t).push(nameTokens(authors));

        if (added % 25 === 0) console.log(`  added ${added}/${ADD_TARGET} · scanned ${scanned} · already had ${had}`);
        consecutiveFailures = 0;
      } catch (err) {
        failed++;
        consecutiveFailures++;
        console.log(`✗ "${title}" — ${err.message.split('\n')[0]}`);
        // One bad record is normal; ten in a row means the database has gone
        // away and every remaining write will fail too. Stopping leaves a
        // usable checkpoint instead of grinding through 5,000 more ranks
        // logging the same error.
        if (consecutiveFailures >= 10) {
          console.log(`\nSTOPPED — ${consecutiveFailures} consecutive write failures. Re-run to resume from rank ${offset}.`);
          break outer;
        }
      }

      if (added >= ADD_TARGET) break outer;
    }

    offset += PAGE;
    if (!DRY) saveCheckpoint({ offset, seen: [...seen] });
  }

  if (!DRY) saveCheckpoint({ offset, seen: [...seen] });

  const total = await prisma.mediaItem.count({ where: { mediaType: 'BOOK' } });
  console.log(`\nscanned ${scanned} ranked works · added ${added} · already had ${had} · thin records skipped ${skippedThin} · failed ${failed}`);
  console.log(`retitled to their English edition: ${renamed} · implausible years dropped: ${noYear}`);
  console.log(`already-had breakdown: ${JSON.stringify(hadBy)}`);
  console.log(`books in catalogue: ${total}${DRY ? ' (unchanged — dry run)' : ''}`);
  if (!DRY && added) console.log(`\nNext: node scripts/audit-cover-mismatches.js — popular works have many editions, which is where covers go wrong.`);

  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
