#!/usr/bin/env node
//
// Flag reviews that arrived via an importer, retroactively.
//
//   node scripts/mark-imported-reviews.js [--dry-run] [--burst N]
//
// src/routes/imports.js now sets Review.isImported at write time, but rows
// created before that carry nothing, so the feed still shows them as though
// somebody watched forty films in one minute.
//
// There is no record of how an old review was created, so this infers it from
// the one signature an import leaves: a block of reviews by the same person in
// the same minute. A person writing by hand does not publish five reviews in
// sixty seconds; an importer publishes dozens.
//
// Deliberately conservative. It will miss a small import — two or three rows
// in one go look exactly like somebody rating a few things quickly — and that
// is the right way to be wrong here: wrongly hiding a review somebody actually
// wrote is worse than leaving a couple of imported ones in a feed. Anything it
// misses stays visible, which is the status quo.
//
// Nothing is deleted and nothing is unmarked; --dry-run shows the work first.

const prisma = require('../src/lib/prisma');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// 8, not 5. At 5 this flagged seven separate groups of exactly five reviews
// by one user across August — someone working down a list a few at a time,
// one of them with written text. Their 951 reviews are spread over 85 days
// and never exceed a handful a minute, so they are hand-entered. Five in a
// minute is a person in a hurry; dozens is a machine.
const BURST = Number(args[args.indexOf('--burst') + 1]) || 8;

(async () => {
  console.log(`\n${dryRun ? '[DRY RUN — nothing is written]\n' : ''}`);
  console.log(`Treating ${BURST}+ reviews by one person in the same minute as an import.\n`);

  const rows = await prisma.review.findMany({
    where: { isImported: false },
    select: {
      id: true, userId: true, createdAt: true, reviewText: true,
      user: { select: { username: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Group by author + minute.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.userId}|${r.createdAt.toISOString().slice(0, 16)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const bursts = [...groups.entries()].filter(([, v]) => v.length >= BURST);
  if (!bursts.length) { console.log('No bursts found — nothing to mark.\n'); await prisma.$disconnect(); return; }

  let total = 0, withText = 0;
  for (const [key, group] of bursts) {
    const when = key.split('|')[1].replace('T', ' ');
    const texted = group.filter(r => r.reviewText).length;
    total += group.length;
    withText += texted;
    console.log(`  ${when}  ${String(group.length).padStart(4)} reviews  @${group[0].user.username}`
      + (texted ? `   (${texted} have written text)` : ''));
  }

  console.log(`\n  ${total} reviews would be marked as imported and hidden from the feed.`);
  if (withText) {
    // Worth saying out loud: an import CAN carry writing (Letterboxd's
    // reviews.csv), so written text does not prove somebody typed it here.
    console.log(`  ${withText} of them carry written text — Letterboxd exports include reviews,`);
    console.log(`  so that is expected, but check the list above looks like an import.`);
  }

  if (dryRun) { console.log('\nRe-run without --dry-run to apply.\n'); await prisma.$disconnect(); return; }

  const ids = bursts.flatMap(([, g]) => g.map(r => r.id));
  for (let i = 0; i < ids.length; i += 200) {
    await prisma.review.updateMany({
      where: { id: { in: ids.slice(i, i + 200) } },
      data: { isImported: true },
    });
  }
  console.log(`\n  marked ${ids.length} reviews.`);

  const remaining = await prisma.review.count({ where: { isImported: false } });
  console.log(`  ${remaining} reviews remain visible in the feed.\n`);

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
