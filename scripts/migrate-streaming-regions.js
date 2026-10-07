#!/usr/bin/env node
//
// Re-key streamingProviders by country.
//
//   node scripts/migrate-streaming-regions.js [--dry-run]
//
// Turns the old unlabelled block, which was always US data, into
// { "US": { ... } } so other countries can sit beside it.
//
// Raw SQL on purpose, for two reasons. MediaItem.updatedAt is @updatedAt, and
// going through Prisma would stamp 29,501 rows with the moment this ran —
// which is exactly the mistake that scrambled the review feed earlier today
// and needed its own repair script. And the transformation is a single jsonb
// expression the database can do far better than a read-modify-write loop.
//
// Idempotent: a row already carrying a country key is skipped, so this can be
// re-run safely and interrupted without leaving the table half-shaped.

const prisma = require('../src/lib/prisma');
const dryRun = process.argv.includes('--dry-run');

const LEGACY = `"streamingProviders" IS NOT NULL
  AND ("streamingProviders" ? 'flatrate' OR "streamingProviders" ? 'rent'
       OR "streamingProviders" ? 'buy'  OR "streamingProviders" ? 'link')`;

(async () => {
  console.log(`\n${dryRun ? '[DRY RUN — nothing is written]\n' : ''}`);

  const [{ n: legacy }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "MediaItem" WHERE ${LEGACY}`);
  const [{ n: keyed }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "MediaItem" WHERE "streamingProviders" ? 'US'`);

  console.log(`  unkeyed rows to convert   ${legacy}`);
  console.log(`  already region-keyed      ${keyed}`);

  if (!legacy) { console.log('\nNothing to do.\n'); await prisma.$disconnect(); return; }

  const [sample] = await prisma.$queryRawUnsafe(
    `SELECT title, "streamingProviders" sp FROM "MediaItem" WHERE ${LEGACY} LIMIT 1`);
  console.log(`\n  example: ${sample.title}`);
  console.log(`    before  ${JSON.stringify(sample.sp).slice(0, 90)}…`);
  console.log(`    after   {"US": ${JSON.stringify(sample.sp).slice(0, 78)}…}`);

  if (dryRun) { console.log('\nRe-run without --dry-run to apply.\n'); await prisma.$disconnect(); return; }

  // Chunked. This database has run out of disk under a single large update
  // before, and a 29,501-row jsonb rewrite is exactly that shape.
  let done = 0;
  for (;;) {
    const n = await prisma.$executeRawUnsafe(`
      UPDATE "MediaItem"
      SET "streamingProviders" = jsonb_build_object('US', "streamingProviders")
      WHERE id IN (SELECT id FROM "MediaItem" WHERE ${LEGACY} LIMIT 500)`);
    if (!n) break;
    done += n;
    if (done % 5000 === 0) console.log(`    …${done} converted`);
  }

  const [{ n: left }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "MediaItem" WHERE ${LEGACY}`);
  const [{ n: now }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int n FROM "MediaItem" WHERE "streamingProviders" ? 'US'`);
  console.log(`\n  converted ${done}`);
  console.log(`  unkeyed remaining ${left}`);
  console.log(`  region-keyed now  ${now}\n`);

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
