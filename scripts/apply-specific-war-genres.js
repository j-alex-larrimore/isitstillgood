// Adds specific-war genres (World War II, Vietnam War, etc.) to movies and
// TV shows already tagged "War", using TMDB's per-title keyword data —
// same idea and same precision/recall tradeoff as
// apply-setting-genres-tv.js: TMDB keyword coverage is inconsistent, so
// this has good precision but incomplete recall. Additive only: never
// removes "War", only adds the more specific tag alongside it, and skips a
// title that already has a matching specific-war genre.
//
// Mirrors the book side of this (normalizeBookGenres' SPECIFIC_WAR_RULES in
// src/lib/mediaHelpers.js), which uses Open Library subject headings
// instead since that's the per-book signal available there.
//
// Usage: node scripts/apply-specific-war-genres.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { SPECIFIC_WAR_VOCAB: VOCAB, settingGenresFor } = require('../src/lib/mediaHelpers');
const { getTvKeywords, getMovieKeywords } = require('../src/services/mediaLookup');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function processType(mediaType, getKeywords, dryRun) {
  const where = { mediaType, genres: { has: 'War' }, tmdbId: { not: null } };
  if (mediaType === 'TV_SHOW') where.parentId = null;
  const items = await prisma.mediaItem.findMany({ where, select: { id: true, title: true, genres: true, tmdbId: true } });
  console.log(`\n${mediaType}: checking ${items.length} "War"-tagged title(s) against TMDB keywords...`);

  let matchedCount = 0;
  for (const item of items) {
    const keywords = await getKeywords(item.tmdbId);
    const toAdd = settingGenresFor(keywords, VOCAB).filter(g => !item.genres.includes(g));
    if (toAdd.length) {
      matchedCount++;
      const allTerms = Object.values(VOCAB).flat();
      const hit = keywords.filter(k => allTerms.some(t => k.includes(t)));
      console.log(`"${item.title}": +${toAdd.join(', +')}  (keywords: ${hit.join(', ')})`);
      if (!dryRun) {
        await prisma.mediaItem.update({ where: { id: item.id }, data: { genres: [...new Set([...item.genres, ...toAdd])] } });
      }
    }
    await sleep(150);
  }
  console.log(`${mediaType}: matched ${matchedCount} / ${items.length}`);
  return { matched: matchedCount, total: items.length };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Applying specific-war genres${dryRun ? ' (dry run)' : ''}...`);
  const movies = await processType('MOVIE', getMovieKeywords, dryRun);
  const tv = await processType('TV_SHOW', getTvKeywords, dryRun);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Movies: ${movies.matched} / ${movies.total}`);
  console.log(`TV: ${tv.matched} / ${tv.total}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
