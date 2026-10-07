#!/usr/bin/env node
//
// Put Review.updatedAt back to something meaningful.
//
//   node scripts/repair-review-updatedat.js [--dry-run]
//
// WHAT WENT WRONG
//
// Three backfills (badges, early-review flags, imported-review flags) each ran
// updateMany over most of the table. updatedAt is @updatedAt, so Prisma stamped
// every row they touched with the time the script ran — and the feed sorts by
// updatedAt descending, on the principle that an edit should bubble back to the
// top. The result is that every review on the site looks like it was edited
// moments ago, and the feed's order is the order those scripts happened to
// write in rather than anything a person did.
//
// WHAT THIS DOES
//
// Sets updatedAt back to createdAt. For the overwhelming majority that is
// exactly right: they were written once and never touched, so the two were
// equal until the backfills ran.
//
// WHAT IS NOT RECOVERABLE
//
// A review that was genuinely edited had a real updatedAt, and that value is
// already gone — overwritten by the backfills, not by this script. For those,
// createdAt is an approximation. It is a far better one than "a moment ago",
// which is what they all say now.
//
// Raw SQL on purpose: going through Prisma would re-stamp updatedAt with the
// current time, which is the exact bug this is undoing.

const prisma = require('../src/lib/prisma');
const dryRun = process.argv.includes('--dry-run');

(async () => {
  console.log(`\n${dryRun ? '[DRY RUN — nothing is written]\n' : ''}`);

  const [{ n: mismatched }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "Review" WHERE "updatedAt" <> "createdAt"`);
  const [{ n: revisits }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "Review" WHERE "updatedAt" <> "createdAt" AND "isRevisit" = true`);

  console.log(`Reviews whose updatedAt no longer matches createdAt: ${mismatched}`);
  console.log(`  of those, marked as a genuine revisit:            ${revisits}`);
  console.log(`  never edited, so createdAt is simply correct:     ${mismatched - revisits}\n`);

  const spread = await prisma.$queryRawUnsafe(`
    SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int n
    FROM "Review" GROUP BY 1 ORDER BY 1 DESC LIMIT 6`);
  console.log('Feed order after the repair (newest review days):');
  spread.forEach(r => console.log(`  ${r.day.toISOString().slice(0, 10)}  ${r.n} reviews`));

  if (dryRun) { console.log('\nRe-run without --dry-run to apply.\n'); await prisma.$disconnect(); return; }

  // Chunked by id range rather than one statement, for the same reason every
  // other bulk write here is: this database has run out of disk under a large
  // single update before.
  let done = 0;
  for (;;) {
    const n = await prisma.$executeRawUnsafe(`
      UPDATE "Review" SET "updatedAt" = "createdAt"
      WHERE id IN (
        SELECT id FROM "Review" WHERE "updatedAt" <> "createdAt" LIMIT 200
      )`);
    if (!n) break;
    done += n;
  }
  console.log(`\n  repaired ${done} reviews.`);

  const [{ n: left }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "Review" WHERE "updatedAt" <> "createdAt"`);
  console.log(`  remaining mismatches: ${left}\n`);

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
