// Reusable post-import check: given a list of series names (optionally with
// an expected book count), reports gaps in seriesNumber sequence and flags
// near-duplicate series names (e.g. "Tide Child" vs "The Tide Child") that
// would silently split one series across two seriesName values on the site
// — confirmed live this happens when a new batch's seriesName string
// doesn't exactly match what an earlier import already used.
//
// Usage:
//   node scripts/check-series-completeness.js "Series One" "Series Two:5" ...
//   (":N" suffix on a name sets the expected count; omit to just report
//   the highest seriesNumber found without flagging gaps past it)
require('dotenv').config();
const prisma = require('../src/lib/prisma');

function normalizeSeriesName(s) {
  return (s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node scripts/check-series-completeness.js "Series Name" "Series With Count:5" ...');
    process.exit(1);
  }
  const specs = args.map(a => {
    const [name, count] = a.split(':');
    return { name, expected: count ? parseInt(count) : null };
  });

  // Near-duplicate series name check across the WHOLE catalog, not just the
  // requested list — catches a new series accidentally colliding with an
  // existing but differently-punctuated one.
  const allSeries = await prisma.mediaItem.findMany({
    where: { seriesName: { not: null } },
    select: { seriesName: true },
    distinct: ['seriesName'],
  });
  const byNorm = new Map();
  for (const { seriesName } of allSeries) {
    const key = normalizeSeriesName(seriesName);
    if (!byNorm.has(key)) byNorm.set(key, []);
    byNorm.get(key).push(seriesName);
  }
  const requestedNorms = new Set(specs.map(s => normalizeSeriesName(s.name)));
  console.log('=== Near-duplicate series names (touching the requested list) ===');
  let dupeFound = false;
  for (const [key, names] of byNorm) {
    if (names.length > 1 && requestedNorms.has(key)) {
      dupeFound = true;
      console.log('⚠', names.join(' | vs | '));
    }
  }
  if (!dupeFound) console.log('none found');

  console.log('\n=== Completeness ===');
  for (const { name, expected } of specs) {
    const books = await prisma.mediaItem.findMany({ where: { seriesName: name }, select: { seriesNumber: true, verified: true } });
    const nums = books.map(b => b.seriesNumber).filter(n => n != null).sort((a, b) => a - b);
    const max = nums.length ? Math.max(...nums) : 0;
    const target = expected || max;
    const missing = [];
    for (let i = 1; i <= target; i++) if (!nums.includes(i)) missing.push(i);
    const unverified = books.filter(b => !b.verified).length;
    const status = missing.length ? `MISSING #${missing.join(',')}` : 'complete';
    console.log(`${name}: ${books.length}${expected ? '/' + expected : ''} — ${status}${unverified ? ` (${unverified} unverified)` : ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
