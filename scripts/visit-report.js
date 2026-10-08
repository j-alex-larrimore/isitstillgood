#!/usr/bin/env node
//
// Who actually arrived, from your own data.
//
//   node scripts/visit-report.js [--days N] [--bots]
//
// Reads VisitLog. Exists because 311 ad clicks produced no signups and there
// was no way to tell whether anyone had landed — attribution is only written
// at signup, so every visitor who left was invisible, and the only other
// number came from the platform being questioned.
//
// Bots are excluded by default and counted separately. On a site with a
// 70,000-title catalogue they are most of the traffic, and mixing them into a
// conversion rate makes a real problem look like a catastrophe (or hides one).

const prisma = require('../src/lib/prisma');

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 7;
const showBots = args.includes('--bots');
const since = new Date(Date.now() - days * 864e5);

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(2) + '%' : '—');
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

(async () => {
  const total = await prisma.visitLog.count({ where: { createdAt: { gte: since } } });
  if (!total) {
    console.log(`\nNo visits logged in the last ${days} days.`);
    console.log('If the site is live, check that analytics.js is uploaded and POSTing /api/visits.\n');
    await prisma.$disconnect();
    return;
  }

  const bots = await prisma.visitLog.count({ where: { createdAt: { gte: since }, bot: true } });
  const human = total - bots;
  const where = { createdAt: { gte: since }, ...(showBots ? {} : { bot: false }) };

  console.log(`\n── Last ${days} days ──────────────────────────────────────────`);
  console.log(`  page views logged     ${total}`);
  console.log(`  flagged automated     ${bots}  (${pct(bots, total)})`);
  console.log(`  apparently human      ${human}`);
  if (!showBots) console.log(`  (everything below excludes bots — pass --bots to include them)`);

  // Sessions, which is the number that actually means "people".
  const sessions = await prisma.visitLog.findMany({
    where: { ...where, sessionId: { not: null } },
    select: { sessionId: true, path: true, createdAt: true, source: true, clickId: true },
    orderBy: { createdAt: 'asc' },
  });
  const bySession = new Map();
  for (const v of sessions) {
    if (!bySession.has(v.sessionId)) bySession.set(v.sessionId, []);
    bySession.get(v.sessionId).push(v);
  }
  const onePage = [...bySession.values()].filter(s => s.length === 1).length;

  console.log(`\n── Sessions ──────────────────────────────────────────────────`);
  console.log(`  distinct sessions     ${bySession.size}`);
  console.log(`  left after one page   ${onePage}  (${pct(onePage, bySession.size)} bounced)`);
  console.log(`  pages per session     ${bySession.size ? (sessions.length / bySession.size).toFixed(1) : '—'}`);
  console.log(`  (sessions are only grouped for visitors who allowed storage)`);

  const group = async (field, label) => {
    const rows = await prisma.visitLog.groupBy({
      // _all, not the field itself: counting the field counts only its
      // non-null values, so the "(none)" bucket always reported zero of itself.
      by: [field], where, _count: { _all: true },
      orderBy: { _count: { [field]: 'desc' } }, take: 8,
    });
    if (!rows.length) return;
    console.log(`\n── ${label} ──────────────────────────────────────────────`);
    for (const r of rows) {
      console.log(`  ${pad(r[field] ?? '(none)', 34)} ${lpad(r._count._all, 6)}`);
    }
  };

  await group('source', 'Campaign source');
  await group('referrerHost', 'Referrer');
  await group('path', 'Landing path');
  await group('country', 'Country');
  await group('device', 'Device');

  // The number this was built for: ad clicks that actually arrived, against
  // what the platform says it charged for.
  const adVisits = await prisma.visitLog.findMany({
    where: { ...where, clickId: { not: null } },
    select: { clickId: true, clickNetwork: true },
  });
  const distinctClicks = new Set(adVisits.map(v => v.clickId));
  console.log(`\n── Ad clicks that landed ─────────────────────────────────────`);
  console.log(`  page views carrying a click id   ${adVisits.length}`);
  console.log(`  distinct click ids               ${distinctClicks.size}`);
  console.log(`  (compare this with the click count the ad platform bills you for —`);
  console.log(`   a large shortfall means you are paying for clicks that never arrive)`);

  const signups = await prisma.user.count({ where: { createdAt: { gte: since } } });
  // Only an account whose attribution was captured inside the window can be
  // explained by the visits above. One created in the window with nothing
  // attached predates tracking, or arrived by some route this never saw —
  // counting it as a conversion credits the ads with somebody else's signup,
  // which this report read as "2 accounts, 1.29% of sessions" on a day when
  // not one of the 144 ad arrivals registered.
  const attributed = await prisma.user.count({
    where: { createdAt: { gte: since }, attrCapturedAt: { gte: since } },
  });
  console.log(`\n── Outcome ───────────────────────────────────────────────────`);
  console.log(`  accounts created      ${signups}  (any route, including ones predating tracking)`);
  console.log(`  traceable to a visit  ${attributed}`);
  console.log(`  of human page views   ${pct(attributed, human)}`);
  if (bySession.size) console.log(`  of sessions           ${pct(attributed, bySession.size)}`);
  console.log();

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
