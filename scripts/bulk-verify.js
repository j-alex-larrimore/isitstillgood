// scripts/bulk-verify.js
//
// Flips pending (verified:false) MediaItems to verified:true in bulk —
// the admin UI approves one at a time, which doesn't scale to a large
// bulk-import backlog.
//
//   node scripts/bulk-verify.js                 # dry run (default)
//   node scripts/bulk-verify.js --confirm       # actually verify
//   node scripts/bulk-verify.js --confirm --include-incomplete
//
// Verifying is what makes an item public, so by default this REFUSES rows
// that are missing a cover, a real description, or a release year — those
// render as broken cards on Browse and are the main thing an admin would
// have caught by eye. Pass --include-incomplete to approve them anyway.
//
// TV seasons are verified alongside their parent: approving a show but
// leaving its seasons pending would publish a series page whose season
// picker is empty, and a season can't be reviewed while it's unverified.
//
// Reversible: an item can be set back to verified:false, so this is not a
// one-way door — but it does publish everything it touches.

require('dotenv').config();
const prisma = require('../src/lib/prisma');

const CONFIRM = process.argv.includes('--confirm');
const INCLUDE_INCOMPLETE = process.argv.includes('--include-incomplete');

function incompleteReason(i) {
  if (!i.imageUrl) return 'no cover';
  if (!i.description || i.description.length < 40) return 'thin/no description';
  if (!i.releaseYear) return 'no release year';
  return null;
}

async function main() {
  const pending = await prisma.mediaItem.findMany({
    where: { verified: false },
    select: {
      id: true, title: true, mediaType: true, releaseYear: true,
      imageUrl: true, description: true, parentId: true,
    },
  });

  if (!pending.length) { console.log('Nothing pending — queue is empty.'); return; }

  const flagged = pending.map(i => ({ item: i, why: incompleteReason(i) })).filter(x => x.why);
  const flaggedIds = new Set(flagged.map(x => x.item.id));
  const toVerify = INCLUDE_INCOMPLETE ? pending : pending.filter(i => !flaggedIds.has(i.id));

  const byType = {};
  for (const i of toVerify) {
    const k = i.mediaType === 'TV_SHOW' ? (i.parentId ? 'TV_SHOW (season)' : 'TV_SHOW (series)') : i.mediaType;
    byType[k] = (byType[k] || 0) + 1;
  }

  console.log(`Pending: ${pending.length}`);
  console.log(`Will verify: ${toVerify.length}${CONFIRM ? '' : '  (dry run — no writes)'}`);
  Object.entries(byType).sort().forEach(([k, v]) => console.log(`   ${k.padEnd(18)} ${v}`));

  if (flagged.length) {
    console.log(`\nHeld back as incomplete: ${flagged.length}${INCLUDE_INCOMPLETE ? ' (overridden — will verify anyway)' : ''}`);
    flagged.slice(0, 25).forEach(f =>
      console.log(`   ~ ${f.item.mediaType} "${f.item.title}" — ${f.why}`));
    if (flagged.length > 25) console.log(`   … and ${flagged.length - 25} more`);
    if (!INCLUDE_INCOMPLETE) console.log('   (re-run with --include-incomplete to approve these too)');
  }

  if (!CONFIRM) {
    console.log('\nDry run only. Re-run with --confirm to verify.');
    return;
  }

  // Chunked so one oversized statement can't blow up, and so an interrupted
  // run leaves a consistent partial state rather than an all-or-nothing gap.
  const ids = toVerify.map(i => i.id);
  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const r = await prisma.mediaItem.updateMany({
      where: { id: { in: slice } },
      data: { verified: true },
    });
    done += r.count;
    console.log(`  verified ${done}/${ids.length}`);
  }

  console.log(`\nVerified ${done} item(s). Still pending: ${await prisma.mediaItem.count({ where: { verified: false } })}.`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
