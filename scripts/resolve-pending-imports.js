#!/usr/bin/env node
//
// Resolve imported ratings that had nowhere to go.
//
//   node scripts/resolve-pending-imports.js [--dry-run] [--limit N] [--user <username>]
//
// An import used to drop every row it could not match. The reader had already
// done the work of exporting their library, and the only thing between them and
// their rating was a title this catalogue did not happen to hold — so the
// rating was discarded and they were told, accurately and uselessly, that it
// was not in the catalogue. src/routes/imports.js now keeps those rows as
// PendingImport; this is the pass that finishes the job.
//
// For each waiting row:
//
//   1. Look in the catalogue again. Most rows resolve here and cost nothing —
//      the weekly release sync, a bulk import or an admin add may well have
//      brought the title in since.
//   2. Failing that, look it up against the same providers the admin UI uses
//      and add it. New entries are created verified:false, matching
//      bulk-import.js: a title nobody vetted queues for admin review before it
//      shows up publicly. AUTO_PUBLISH below flips that in one line.
//   3. Write the review — unless one is already there and disagrees, in which
//      case the row becomes a CONFLICT and the reader is asked. We never
//      overwrite a review someone wrote by hand with one that arrived late.
//   4. Tell the reader, through the same Notification channel as everything
//      else.
//
// Rows that keep missing are retried on a widening backoff and eventually left
// alone, so a title that genuinely does not exist stops costing provider quota.
//
// Needs the provider keys in .env (TMDB_READ_ACCESS_TOKEN, GOOGLE_BOOKS_API_KEY)
// to do step 2; without them it still does steps 1, 3 and 4, which is the
// cheap half and catches most rows.

const prisma = require('../src/lib/prisma');
const {
  slugify, uniqueSlug, connectPersons, connectCast,
  normalizeTags, normalizeGenres, normalizeBookGenres,
  normalizeTitleForSearch, detectStreamingTags,
} = require('../src/lib/mediaHelpers');
const { lookupMovieOrTv, lookupBook } = require('./bulk-import');

// A freshly looked-up title queues for admin review rather than going straight
// live, which is bulk-import.js's deliberate default. The weekly release sync
// is the documented exception, not this.
const AUTO_PUBLISH = false;

// Retry schedule, in days since the last attempt. A row that has missed this
// many times is left alone.
const BACKOFF_DAYS = [0, 1, 3, 7, 14, 30];
const MAX_ATTEMPTS = BACKOFF_DAYS.length;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limit = Number(args[args.indexOf('--limit') + 1]) || 200;
const onlyUser = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;

const ratingToVerdict = r =>
  r <= 3 ? 'NOT_GOOD' : r <= 6 ? 'MIXED' : r <= 8 ? 'STILL_GOOD' : 'TIMELESS';

const normIsbn = v => String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase() || null;
const norm = t => normalizeTitleForSearch(String(t || ''));

// ─── Step 1: is it in the catalogue now? ────────────────────────────────────
// Same precedence the importers use: an exact external key first, then title
// with corroboration. A title alone is never enough — that is how "Self" by
// Yann Martel ended up wearing Brandon Sanderson's cover.
async function findInCatalogue(p) {
  const scope = p.mediaType === 'BOOK'
    ? { mediaType: 'BOOK' }
    : { mediaType: p.mediaType, parentId: null };

  if (p.imdbId) {
    const hit = await prisma.mediaItem.findFirst({ where: { ...scope, imdbId: p.imdbId } });
    if (hit) return { hit, how: 'imdbId' };
  }
  if (p.isbn) {
    const isbn = normIsbn(p.isbn);
    const hit = await prisma.mediaItem.findFirst({
      where: { mediaType: 'BOOK', OR: [{ isbns: { hasSome: [isbn] } }, { isbn13: isbn }] },
    });
    if (hit) return { hit, how: 'isbn' };
  }

  // Goodreads writes the series into the title, so try the bare title too —
  // the same keys src/routes/imports.js matches on.
  const keys = [...new Set([norm(p.title), norm(String(p.title).replace(/\s*\([^()]*#[^()]*\)\s*$/, ''))])].filter(Boolean);
  const candidates = await prisma.mediaItem.findMany({
    where: { ...scope, normalizedTitle: { in: keys } },
    include: { authors: { select: { name: true } } },
  });
  if (!candidates.length) return null;

  if (p.mediaType === 'BOOK' && p.author) {
    const want = new Set(norm(p.author).split(' ').filter(t => t.length > 2));
    const byAuthor = candidates.filter(c =>
      c.authors.some(a => norm(a.name).split(' ').some(t => want.has(t))));
    if (byAuthor.length === 1) return { hit: byAuthor[0], how: 'title+author' };
    return null;
  }

  if (p.year) {
    const exact = candidates.filter(c => c.releaseYear === p.year);
    if (exact.length === 1) return { hit: exact[0], how: 'title+year' };
    const near = candidates.filter(c => Math.abs((c.releaseYear || 0) - p.year) <= 1);
    if (near.length === 1) return { hit: near[0], how: 'title+year~' };
    return null;
  }

  return candidates.length === 1 ? { hit: candidates[0], how: 'title' } : null;
}

// ─── Step 2: add it ─────────────────────────────────────────────────────────
async function addToCatalogue(p) {
  const row = {
    title: p.title, year: p.year, author: p.author,
    mediaType: p.mediaType, tags: [], seriesName: null, seriesNumber: null,
  };

  const data = p.mediaType === 'BOOK' ? await lookupBook(row) : await lookupMovieOrTv(row);
  if (!data) return null;

  // The provider has to agree it is the same title. pickBestMatch already
  // refuses a weak match, but a returned title that is nothing like the one
  // asked for is how a wrong book gets a reader's rating attached to it.
  if (norm(data.title) !== norm(p.title)
      && !norm(data.title).startsWith(norm(p.title))
      && !norm(p.title).startsWith(norm(data.title))) {
    return { rejected: `provider returned "${data.title}"` };
  }

  const releaseYear = (p.mediaType === 'BOOK' && p.year) ? p.year : data.releaseYear;
  const genres = p.mediaType === 'BOOK'
    ? normalizeBookGenres(data.genres || [])
    : normalizeGenres(data.genres || []);
  const tags = normalizeTags(p.mediaType === 'TV_SHOW'
    ? detectStreamingTags(data.networks, data.productionCompanies) : []);

  if (dryRun) return { dryRun: true, title: data.title, releaseYear };

  const slug = await uniqueSlug(slugify(data.title, releaseYear));
  const castData = await connectCast(data.cast || []);
  const created = await prisma.mediaItem.create({
    data: {
      mediaType: p.mediaType,
      title: data.title,
      normalizedTitle: normalizeTitleForSearch(data.title),
      slug,
      releaseYear,
      verified: AUTO_PUBLISH,
      description: data.description || null,
      imageUrl: data.imageUrl || null,
      genres, tags,
      tmdbId: data.tmdbId || null,
      tmdbRating: data.tmdbRating || null,
      seasons: data.seasons || null,
      isbn13: data.isbn13 || normIsbn(p.isbn),
      isbns: [data.isbn13, normIsbn(p.isbn)].filter(Boolean),
      imdbId: p.imdbId || null,
      directors: await connectPersons(data.directors || []),
      cast: castData.cast,
      castOrder: castData.castOrder,
      authors: await connectPersons(data.authors || []),
    },
  });
  return { created };
}

// ─── Steps 3 and 4: write the review, tell the reader ───────────────────────
async function applyReview(p, mediaItem) {
  const existing = await prisma.review.findFirst({
    where: { userId: p.userId, mediaItemId: mediaItem.id, seasonNumber: null },
    select: { id: true, rating: true, reviewText: true },
  });

  const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
  if (existing) {
    const ratingDiffers = existing.rating !== p.rating;
    const textDiffers = !!(clean(p.reviewText) && clean(existing.reviewText)
      && clean(p.reviewText) !== clean(existing.reviewText));

    if (ratingDiffers || textDiffers) {
      // Never overwrite something written by hand with something that arrived
      // late. Capture both sides so the question still makes sense in a week.
      if (dryRun) return { outcome: 'conflict', mediaItem };
      await prisma.pendingImport.update({
        where: { id: p.id },
        data: {
          status: 'CONFLICT', mediaItemId: mediaItem.id, reviewId: existing.id,
          conflictRating: existing.rating, conflictReviewText: existing.reviewText,
          lastTriedAt: new Date(),
        },
      });
      await notify(p, 'IMPORT_CONFLICT', {
        pendingImportId: p.id, title: mediaItem.title, slug: mediaItem.slug,
        mediaType: p.mediaType, source: p.source,
        importedRating: p.rating, existingRating: existing.rating,
        ratingDiffers, textDiffers,
      });
      return { outcome: 'conflict', mediaItem };
    }

    // Already says the same thing. Nothing to write and nothing worth a
    // notification — the reader would only be told their rating matches itself.
    if (dryRun) return { outcome: 'already', mediaItem };
    const addsText = !!(clean(p.reviewText) && !clean(existing.reviewText));
    if (addsText) {
      await prisma.review.update({ where: { id: existing.id }, data: { reviewText: p.reviewText } });
    }
    await prisma.pendingImport.update({
      where: { id: p.id },
      data: { status: 'RESOLVED', mediaItemId: mediaItem.id, reviewId: existing.id, resolvedAt: new Date() },
    });
    return { outcome: addsText ? 'enriched' : 'already', mediaItem };
  }

  if (dryRun) return { outcome: 'written', mediaItem };
  const review = await prisma.review.create({
    data: {
      userId: p.userId, mediaItemId: mediaItem.id,
      rating: p.rating, verdict: ratingToVerdict(p.rating),
      reviewText: p.reviewText || null,
      dateConsumed: p.dateConsumed || null,
      visibility: p.visibility,
      seasonNumber: null, isRevisit: false, isDraft: false,
    },
  });
  await prisma.pendingImport.update({
    where: { id: p.id },
    data: { status: 'RESOLVED', mediaItemId: mediaItem.id, reviewId: review.id, resolvedAt: new Date() },
  });
  await notify(p, 'IMPORT_RESOLVED', {
    pendingImportId: p.id, title: mediaItem.title, slug: mediaItem.slug,
    mediaType: p.mediaType, source: p.source, rating: p.rating,
    hasReviewText: !!p.reviewText,
  });
  return { outcome: 'written', mediaItem };
}

// Notifications are best-effort: a failure here must not lose the review that
// was just written, which is the thing that actually mattered.
const notify = (p, type, payload) =>
  prisma.notification.create({ data: { userId: p.userId, type, payload } })
    .catch(e => console.error(`  ! notification failed: ${e.message}`));

// ─── Main ───────────────────────────────────────────────────────────────────
function isDue(p) {
  if (!p.lastTriedAt) return true;
  const waitDays = BACKOFF_DAYS[Math.min(p.attempts, BACKOFF_DAYS.length - 1)];
  return Date.now() - p.lastTriedAt.getTime() >= waitDays * 864e5;
}

async function main() {
  const where = { status: 'PENDING', ...(onlyUser ? { user: { username: onlyUser } } : {}) };
  const all = await prisma.pendingImport.findMany({
    where, orderBy: { createdAt: 'asc' }, take: limit * 3,
    include: { user: { select: { username: true } } },
  });
  const due = all.filter(isDue).slice(0, limit);

  console.log(`\n${all.length} waiting, ${due.length} due a look${dryRun ? '  [DRY RUN — nothing is written]' : ''}\n`);
  if (!due.length) { console.log('Nothing to do.\n'); return; }

  const tally = { found: 0, added: 0, written: 0, enriched: 0, conflict: 0, already: 0, rejected: 0, missed: 0, givenUp: 0 };

  for (const p of due) {
    const label = `${p.title}${p.year ? ` (${p.year})` : ''} — @${p.user.username}`;
    try {
      let found = await findInCatalogue(p);
      if (found) tally.found++;

      if (!found) {
        const add = await addToCatalogue(p);
        await sleep(1100);                       // provider rate limits

        if (add && add.dryRun) {
          console.log(`  + ${label}\n      would add "${add.title}" (${add.releaseYear || 'year unknown'})`);
          tally.added++;
          continue;
        }
        if (add && add.rejected) {
          console.log(`  ? ${label}\n      no confident match — ${add.rejected}`);
          found = null;
        } else if (add && add.created) {
          found = { hit: add.created, how: 'added' };
          tally.added++;
        }
      }

      if (!found) {
        const attempts = p.attempts + 1;
        const givingUp = attempts >= MAX_ATTEMPTS;
        if (!dryRun) {
          await prisma.pendingImport.update({
            where: { id: p.id },
            data: { attempts, lastTriedAt: new Date(), ...(givingUp ? { status: 'UNRESOLVABLE' } : {}) },
          });
        }
        console.log(`  · ${label} — still not found (attempt ${attempts}${givingUp ? ', giving up' : ''})`);
        tally[givingUp ? 'givenUp' : 'missed']++;
        continue;
      }

      const { outcome } = await applyReview(p, found.hit);
      tally[outcome]++;
      const mark = { written: '✓', enriched: '✓', conflict: '!', already: '=' }[outcome];
      console.log(`  ${mark} ${label}\n      ${found.how} -> ${found.hit.title}  [${outcome}]`);
    } catch (err) {
      console.log(`  ✗ ${label} — ${err.message}`);
      if (!dryRun) {
        await prisma.pendingImport.update({
          where: { id: p.id }, data: { attempts: p.attempts + 1, lastTriedAt: new Date() },
        }).catch(() => {});
      }
      tally.missed++;
    }
  }

  console.log('\n─── summary ───');
  console.log(`  already in catalogue   ${tally.found}`);
  console.log(`  added to catalogue     ${tally.added}${AUTO_PUBLISH ? '' : '   (unverified — awaiting admin review)'}`);
  console.log(`  reviews written        ${tally.written}`);
  console.log(`  reviews gained text    ${tally.enriched}`);
  console.log(`  conflicts raised       ${tally.conflict}`);
  console.log(`  already agreed         ${tally.already}`);
  console.log(`  still missing          ${tally.missed}`);
  console.log(`  given up on            ${tally.givenUp}`);
  console.log();
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
