// One-off backfill: populate MediaItem.normalizedTitle for every existing row.
// The migration that added the column only sets it going forward (new writes
// go through admin.js/bulk-import.js, which already compute it) — this fills
// in NULL values for everything created before that. Safe to re-run.
const { PrismaClient } = require('@prisma/client');
const { normalizeTitleForSearch } = require('../src/lib/mediaHelpers');

const prisma = new PrismaClient();

const BATCH_SIZE = 500;

async function main() {
  const items = await prisma.mediaItem.findMany({
    where: { normalizedTitle: null },
    select: { id: true, title: true },
  });

  console.log(`${items.length} items missing normalizedTitle`);

  let updated = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const ids = batch.map((item) => item.id);
    const values = batch.map((item) => normalizeTitleForSearch(item.title));

    // Single round-trip bulk update per batch instead of one UPDATE per row —
    // 59k individual awaits over the remote Railway connection dropped mid-run.
    await prisma.$executeRawUnsafe(
      `UPDATE "MediaItem" AS m
       SET "normalizedTitle" = v.normalized
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS normalized) AS v
       WHERE m.id = v.id`,
      ids,
      values
    );

    updated += batch.length;
    console.log(`${updated}/${items.length}`);
  }

  console.log(`Done. Updated ${updated} items.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
