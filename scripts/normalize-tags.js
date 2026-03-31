// One-time migration script to normalize existing tags in the database
// Run with: node scripts/normalize-tags.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TAG_OVERRIDES = {
  'hbo': 'HBO', 'hbo max': 'HBO Max', 'hbomax': 'HBO Max',
  'apple tv': 'Apple TV', 'apple tv+': 'Apple TV+',
  'nbc': 'NBC', 'cbs': 'CBS', 'abc': 'ABC', 'amc': 'AMC', 'fx': 'FX',
  'bbc': 'BBC', 'pbs': 'PBS', 'mtv': 'MTV', 'vh1': 'VH1', 'bravo': 'Bravo',
  'usa': 'USA', 'tnt': 'TNT', 'tbs': 'TBS', 'syfy': 'Syfy', 'cnbc': 'CNBC',
  'cnn': 'CNN', 'espn': 'ESPN', 'nfl': 'NFL', 'nba': 'NBA', 'mlb': 'MLB',
  'nhl': 'NHL', 'dc': 'DC', 'mcu': 'MCU', 'dceu': 'DCEU', 'lgbtq': 'LGBTQ',
  'lgbtq+': 'LGBTQ+', 'wwii': 'WWII', 'wwi': 'WWI', 'uk': 'UK', 'us': 'US',
};

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return tags;
  return tags.map(t => {
    const trimmed = t.trim();
    const lower = trimmed.toLowerCase();
    if (TAG_OVERRIDES[lower]) return TAG_OVERRIDES[lower];
    return trimmed.split(' ').map(w => {
      const wl = w.toLowerCase();
      if (TAG_OVERRIDES[wl]) return TAG_OVERRIDES[wl];
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  });
}

function tagsChanged(original, normalized) {
  if (original.length !== normalized.length) return true;
  return original.some((t, i) => t !== normalized[i]);
}

async function main() {
  console.log('Fetching all items with tags...');
  const items = await prisma.mediaItem.findMany({
    where: { tags: { isEmpty: false } },
    select: { id: true, title: true, tags: true },
  });

  console.log(`Found ${items.length} items with tags.`);

  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const normalized = normalizeTags(item.tags);
    if (!tagsChanged(item.tags, normalized)) {
      skipped++;
      continue;
    }
    console.log(`  Updating: "${item.title}"`);
    console.log(`    Before: ${item.tags.join(', ')}`);
    console.log(`    After:  ${normalized.join(', ')}`);
    await prisma.mediaItem.update({
      where: { id: item.id },
      data: { tags: normalized },
    });
    updated++;
  }

  console.log(`\nDone. Updated ${updated} items, skipped ${skipped} unchanged.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
