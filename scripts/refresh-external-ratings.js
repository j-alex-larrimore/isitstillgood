#!/usr/bin/env node
//
// Refreshes TMDB ratings for films and TV, and IGDB ratings for games.
//
//   node scripts/refresh-external-ratings.js [--limit N] [--days N]
//                                            [--type MOVIE,TV_SHOW,VIDEO_GAME]
//                                            [--delay MS] [--dry-run]
//
// Exists because refreshStaleRatings() was never called by anything — not a
// cron, not a route, not startup. The only external ratings ever written came
// from someone pressing sync on a single item, which is why 40,141 of 42,190
// refreshable items had never been touched and the most recent refresh of any
// kind was 7 July 2026.
//
// Oldest first, never-refreshed before everything else, so the backlog drains
// rather than starving behind rows that already have a value.
//
// Paced at ~4 requests a second by default, which is IGDB's documented
// ceiling. TMDB is far more generous but shares the loop; the limiting factor
// is the games, and a uniform delay keeps this simple and polite.
//
// Books are not covered: none carries an external id and fetchExternalRatings
// has no book branch, so there is nothing to fetch. See the note in
// src/services/externalRatings.js.

const prisma = require('../src/lib/prisma');
const { refreshStaleRatings } = require('../src/services/externalRatings');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const limit   = Number(flag('--limit', 200));
const days    = Number(flag('--days', 7));
const delayMs = Number(flag('--delay', 250));
const dryRun  = args.includes('--dry-run');
const types   = flag('--type', null);
const mediaTypes = types ? types.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null;

(async () => {
  const started = Date.now();
  console.log(`\nRefreshing external ratings`);
  console.log(`  limit ${limit}   stale after ${days}d   delay ${delayMs}ms` +
              `${mediaTypes ? '   types ' + mediaTypes.join(',') : ''}${dryRun ? '   DRY RUN' : ''}\n`);

  let done = 0;
  const res = await refreshStaleRatings({
    limit, olderThanDays: days, mediaTypes, delayMs, dryRun,
    onProgress: ({ item, error, stats }) => {
      if (error) { console.log(`  ! ${item.title}: ${error.message.split('\n')[0]}`); return; }
      if (!stats) return;
      done++;
      if (done % 25 === 0 || done === stats.attempted) {
        console.log(`  ${done}/${stats.attempted}  updated ${stats.updated}  unchanged ${stats.unchanged}  failed ${stats.failed}`);
      }
    },
  });

  if (dryRun) {
    console.log(`  ${res.due} items are due. Next ${res.attempted} would be:`);
    res.sample.forEach(i =>
      console.log(`    ${i.mediaType.padEnd(11)} ${(i.title || '').slice(0, 48).padEnd(50)} ` +
                  `${i.externalRatingsUpdatedAt ? i.externalRatingsUpdatedAt.toISOString().slice(0, 10) : 'never'}`));
  } else {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`\n  attempted ${res.attempted} of ${res.due} due`);
    console.log(`  updated   ${res.updated}`);
    console.log(`  unchanged ${res.unchanged}   (provider returned nothing usable)`);
    console.log(`  failed    ${res.failed}`);
    console.log(`  remaining ${Math.max(0, res.due - res.updated)}   in ${mins} min\n`);
  }

  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
