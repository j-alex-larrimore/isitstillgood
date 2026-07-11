// Applies the Schools/Courtroom/Legal/Police setting genres to existing TV
// shows using TMDB's per-show keyword data (/tv/{id}/keywords). Keyword
// coverage on TMDB is inconsistent — many shows return no keywords at all —
// so this has good precision (matched keywords are curated, real signals)
// but incomplete recall (a show can genuinely qualify and just not get
// caught if TMDB never tagged it). Additive only: never removes a genre,
// only pushes new ones, and skips a genre a show already has.
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { SETTING_GENRE_VOCAB: VOCAB } = require('../src/lib/mediaHelpers');
const { getTvKeywords: getKeywords } = require('../src/services/mediaLookup');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const shows = await prisma.mediaItem.findMany({
    where: { mediaType: 'TV_SHOW', parentId: null, tmdbId: { not: null } },
    select: { id: true, title: true, genres: true, tmdbId: true },
  });
  console.log(`Checking ${shows.length} existing TV shows against TMDB keywords${dryRun ? ' (dry run)' : ''}...\n`);

  let matchedCount = 0;
  for (const show of shows) {
    const keywords = await getKeywords(show.tmdbId);
    const toAdd = [];
    // Substring match, not exact — "police corruption"/"police brutality"
    // (We Own This City) should count as a Police signal just as much as
    // the bare word "police" does.
    for (const [genre, terms] of Object.entries(VOCAB)) {
      if (show.genres.includes(genre)) continue;
      if (terms.some(t => keywords.some(k => k.includes(t)))) toAdd.push(genre);
    }
    if (toAdd.length) {
      matchedCount++;
      const allTerms = Object.values(VOCAB).flat();
      const hit = keywords.filter(k => allTerms.some(t => k.includes(t)));
      console.log(`"${show.title}": +${toAdd.join(', +')}  (keywords: ${hit.join(', ')})`);
      if (!dryRun) {
        await prisma.mediaItem.update({ where: { id: show.id }, data: { genres: [...new Set([...show.genres, ...toAdd])] } });
      }
    }
    await sleep(150);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Shows matching at least one setting genre: ${matchedCount} / ${shows.length}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
