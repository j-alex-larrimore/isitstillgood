#!/usr/bin/env node
//
// Award badges for work already done.
//
//   node scripts/backfill-badges.js [--dry-run]
//
// Badges are granted going forward by src/routes/reviews.js, which only fires
// when someone writes a review. Without this, the people who have been
// reviewing since before badges existed — the only people a Pioneer badge is
// actually about — would hold nothing, and Pioneer #1 would go to whoever
// happened to review next.
//
// Two passes:
//
//   1. Review.isFirstReview, decided by who published first on each media item.
//      Ordered by createdAt so the credit lands where it historically belongs
//      rather than wherever the scan happens to start.
//   2. User badges, via the same syncBadges the live path uses — so a
//      backfilled user and a new one are awarded by identical rules.
//
// Pioneer numbers are assigned in order of each user's FIRST published review,
// which is the only ordering that means anything: it is a record of who showed
// up first, not of who the database happened to list first.
//
// Safe to re-run. Nothing is revoked and nothing is renumbered.

const prisma = require('../src/lib/prisma');
const { syncBadges, presentBadge, PIONEER_LIMIT, EARLY_REVIEW_LIMIT } = require('../src/lib/badges');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  console.log(`\n${dryRun ? '[DRY RUN — nothing is written]\n' : ''}`);

  // ─── Pass 1: who was first on each title ─────────────────────────────────
  const published = await prisma.review.findMany({
    where: { isDraft: false, visibility: 'PUBLIC' },
    select: { id: true, mediaItemId: true, userId: true, createdAt: true, isFirstReview: true, isEarlyReview: true },
    orderBy: { createdAt: 'asc' },
  });

  // Position within each title's review list, oldest first. Two flags fall out
  // of it: the very first review, and the first EARLY_REVIEW_LIMIT of them.
  const seenPerTitle = new Map();
  const toMarkFirst = [];
  const toMarkEarly = [];
  for (const r of published) {
    const n = seenPerTitle.get(r.mediaItemId) || 0;
    seenPerTitle.set(r.mediaItemId, n + 1);
    if (n === 0 && !r.isFirstReview) toMarkFirst.push(r);
    if (n < EARLY_REVIEW_LIMIT && !r.isEarlyReview) toMarkEarly.push(r);
  }

  const deepest = Math.max(0, ...seenPerTitle.values());
  console.log(`Published public reviews: ${published.length} across ${seenPerTitle.size} titles`);
  console.log(`Most reviews on any one title: ${deepest}`);
  console.log(`First-review flags to set: ${toMarkFirst.length}`);
  console.log(`Early-review flags to set:  ${toMarkEarly.length}`);

  // Chunked rather than one statement per row — a few hundred rows today, but
  // this runs against the same volume-constrained database that a 23,000-row
  // update once filled.
  const markAll = async (rows, data) => {
    for (let i = 0; i < rows.length; i += 200) {
      await prisma.review.updateMany({
        where: { id: { in: rows.slice(i, i + 200).map(r => r.id) } },
        data,
      });
    }
  };
  if (!dryRun) {
    if (toMarkFirst.length) await markAll(toMarkFirst, { isFirstReview: true });
    if (toMarkEarly.length) await markAll(toMarkEarly, { isEarlyReview: true });
  }

  // ─── Pass 2: user badges ─────────────────────────────────────────────────
  // Ordered by each user's first published review, so Pioneer numbers follow
  // the order people actually started contributing.
  const order = [];
  const seenUser = new Set();
  for (const r of published) {
    if (!seenUser.has(r.userId)) { seenUser.add(r.userId); order.push(r.userId); }
  }

  console.log(`\nUsers with at least one published review: ${order.length}`);
  if (dryRun) {
    console.log(`Would award Pioneer in this order (first ${Math.min(order.length, PIONEER_LIMIT)}):`);
    const names = await prisma.user.findMany({
      where: { id: { in: order.slice(0, PIONEER_LIMIT) } },
      select: { id: true, username: true },
    });
    const by = new Map(names.map(u => [u.id, u.username]));
    order.slice(0, PIONEER_LIMIT).forEach((id, i) => console.log(`  #${i + 1}  ${by.get(id) || id}`));
    await prisma.$disconnect();
    return;
  }

  let awarded = 0;
  for (const userId of order) {
    const got = await syncBadges(prisma, userId);
    if (got.length) awarded += got.length;
  }

  // ─── What everyone ended up with ─────────────────────────────────────────
  const rows = await prisma.userBadge.findMany({
    include: { user: { select: { username: true } } },
    orderBy: [{ code: 'asc' }, { number: 'asc' }],
  });
  console.log(`\nBadges awarded this run: ${awarded}`);
  console.log(`Badges held in total:    ${rows.length}\n`);
  for (const r of rows) {
    const p = presentBadge(r);
    console.log(`  ${(p ? p.label : r.code).padEnd(16)} ${r.user.username}`);
  }
  console.log();

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
