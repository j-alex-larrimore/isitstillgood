#!/usr/bin/env node
//
// Where your signups came from.
//
//   node scripts/signup-sources.js [--days N] [--list]
//
// Reads the attribution recorded at signup (see POST /api/auth/attribution).
// This exists so the question "where did this account come from?" has an answer
// that does not depend on an ad platform's dashboard being truthful, or even
// reachable — when Reddit showed zero impressions and a signup appeared the
// same morning, there was no way to tell which of them was wrong.
//
// Two caveats worth knowing before reading anything into a number here:
//
//   * Attribution is first-touch and per browser. Someone who clicks an ad on
//     their phone and signs up on a laptop records as direct, because the
//     laptop never saw the ad. Every analytics tool has this problem; it means
//     paid sources are undercounted, never overcounted.
//   * Accounts created before this shipped have no attribution at all and are
//     reported separately rather than lumped in with direct, which would
//     invent a fact about them.

const prisma = require('../src/lib/prisma');

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 30;
const list = args.includes('--list');

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

(async () => {
  const since = new Date(Date.now() - days * 864e5);
  const users = await prisma.user.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: {
      username: true, createdAt: true, isVerified: true, canceledAt: true,
      attrSource: true, attrMedium: true, attrCampaign: true, attrContent: true,
      attrRedditClickId: true, attrMetaClickId: true, attrReferrer: true,
      attrLandedOn: true, attrLandedAt: true, attrCapturedAt: true,
      _count: { select: { reviews: true } },
    },
  });

  console.log(`\nSignups in the last ${days} days: ${users.length}\n`);
  if (!users.length) { await prisma.$disconnect(); return; }

  // Grouped by source, then campaign.
  const groups = new Map();
  for (const u of users) {
    const key = u.attrCapturedAt
      ? `${u.attrSource || 'direct'}${u.attrCampaign ? ' / ' + u.attrCampaign : ''}`
      : '(before attribution was recorded)';
    if (!groups.has(key)) groups.set(key, { n: 0, verified: 0, reviewed: 0, clicks: 0 });
    const g = groups.get(key);
    g.n++;
    if (u.isVerified) g.verified++;
    if (u._count.reviews > 0) g.reviewed++;
    if (u.attrRedditClickId || u.attrMetaClickId) g.clicks++;
  }

  console.log(`  ${pad('source / campaign', 42)} ${lpad('signups', 8)} ${lpad('verified', 9)} ${lpad('reviewed', 9)} ${lpad('ad click', 9)}`);
  console.log(`  ${'-'.repeat(42)} ${'-'.repeat(8)} ${'-'.repeat(9)} ${'-'.repeat(9)} ${'-'.repeat(9)}`);
  for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${pad(k.slice(0, 42), 42)} ${lpad(g.n, 8)} ${lpad(g.verified, 9)} ${lpad(g.reviewed, 9)} ${lpad(g.clicks, 9)}`);
  }

  // "reviewed" is the column that matters. A source that delivers signups who
  // never write anything is delivering a number, not an audience.
  console.log(`\n  verified = confirmed their email · reviewed = wrote at least one review`);
  console.log(`  ad click = carried a Reddit or Meta click id, which is proof it came from an ad`);

  if (list) {
    console.log('\n─── individual signups ───\n');
    for (const u of users) {
      const when = u.createdAt.toISOString().replace('T', ' ').slice(0, 16);
      console.log(`  ${when}  ${u.username}`);
      if (!u.attrCapturedAt) { console.log('      (no attribution — predates this feature)\n'); continue; }
      const bits = [
        u.attrSource && `source=${u.attrSource}`,
        u.attrMedium && `medium=${u.attrMedium}`,
        u.attrCampaign && `campaign=${u.attrCampaign}`,
        u.attrContent && `content=${u.attrContent}`,
        u.attrRedditClickId && `rdt_cid=${u.attrRedditClickId.slice(0, 24)}`,
        u.attrMetaClickId && `fbclid=${u.attrMetaClickId.slice(0, 24)}`,
      ].filter(Boolean);
      console.log(`      ${bits.join('  ')}`);
      if (u.attrReferrer) console.log(`      referrer: ${u.attrReferrer.slice(0, 100)}`);
      if (u.attrLandedOn) {
        const lag = u.attrLandedAt
          ? ` (${Math.round((u.createdAt - u.attrLandedAt) / 60000)} min before signing up)` : '';
        console.log(`      landed on ${u.attrLandedOn}${lag}`);
      }
      console.log(`      ${u.isVerified ? 'verified' : 'NOT verified'} · ${u._count.reviews} reviews${u.canceledAt ? ' · canceled' : ''}\n`);
    }
  } else {
    console.log('\n  Run with --list to see each signup individually.\n');
  }

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
