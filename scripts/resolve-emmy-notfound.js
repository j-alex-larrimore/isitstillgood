// One-off, read-only: for each Emmy title that failed TV search (plus the
// known-bad "Martha" TV match), tries both TMDB TV and movie search to
// determine whether it's a genuinely missing episodic series (TV, TMDB
// number_of_seasons > 0) vs. a non-episodic documentary/special that should
// go through the movie pipeline instead. Writes classified results for
// manual confirmation — no DB writes.
require('dotenv').config();
const fs = require('fs');
const prisma = require('../src/lib/prisma');
const { searchTmdb, getTmdbDetail } = require('../src/services/mediaLookup');

const SCRATCH = 'C:/Users/jalex/AppData/Local/Temp/claude/C--Users-jalex-Documents-GitHub-isitstillgood/e2623e02-e5ec-4ff2-8687-a0781bd04abe/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normTitle(t) {
  return (t || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[.,:;!?'"]/g, '').replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
}

async function main() {
  const data = JSON.parse(fs.readFileSync(`${SCRATCH}/missing-emmy-tv.json`, 'utf8'));
  const items = [...data.notFound.map(n => ({ title: n.title, year: n.year })), { title: 'Martha', year: 2024 }];
  console.log(`Resolving ${items.length} items (35 no-match + Martha override)...\n`);

  const existingMovies = await prisma.mediaItem.findMany({ where: { mediaType: 'MOVIE' }, select: { title: true, releaseYear: true } });
  const existingMovieSet = new Set();
  for (const e of existingMovies) for (let dy = -2; dy <= 2; dy++) existingMovieSet.add(`${normTitle(e.title)}|${(e.releaseYear || 0) + dy}`);

  const tvCandidates = [];
  const movieCandidates = [];
  const stillUnresolved = [];

  for (const { title, year } of items) {
    try {
      // No year filter at the API level — the Emmy agent's premiere-year
      // estimates are approximate and TMDB's first_air_date_year param is a
      // hard filter, not a ranking hint, so an off-by-one estimate silently
      // drops the correct show. Search title-only, then rank in-process:
      // exact-title matches first, closest year among those as tiebreaker.
      const tvResults = await searchTmdb(title, 'tv', null);
      const exactTv = tvResults.filter(c => normTitle(c.title) === normTitle(title));
      const tvPool = exactTv.length ? exactTv : (tvResults.length ? [tvResults[0]] : []);
      const tvBest = year
        ? [...tvPool].sort((a, b) => Math.abs((parseInt(a.releaseYear) || 0) - year) - Math.abs((parseInt(b.releaseYear) || 0) - year))[0]
        : tvPool[0];
      let tvSeasons = 0;
      if (tvBest) {
        const detail = await getTmdbDetail(tvBest.tmdbId, 'tv');
        tvSeasons = detail.seasons || 0;
        await sleep(200);
      }

      // An exact title match with a wildly different year is more likely an
      // unrelated show that happens to share a title (e.g. "Martha" 2005
      // talk show vs. the 2024 documentary) than the intended match.
      const yearPlausible = !year || !tvBest?.releaseYear || Math.abs((parseInt(tvBest.releaseYear) || 0) - year) <= 3;
      if (tvBest && exactTv.length && tvSeasons >= 1 && yearPlausible) {
        tvCandidates.push({ tmdbId: tvBest.tmdbId, title: tvBest.title, releaseYear: parseInt(tvBest.releaseYear) || null, seasons: tvSeasons, sourceTitle: title });
        console.log(`[TV] "${tvBest.title}" (${tvBest.releaseYear}) — ${tvSeasons} season(s)`);
        await sleep(200);
        continue;
      }

      const movieResults = await searchTmdb(title, 'movie', year);
      const movieBest = movieResults.find(c => normTitle(c.title) === normTitle(title)) || movieResults[0];
      if (movieBest) {
        const key = `${normTitle(movieBest.title)}|${parseInt(movieBest.releaseYear) || 0}`;
        if (existingMovieSet.has(key)) {
          console.log(`[MOVIE-DUP] "${movieBest.title}" (${movieBest.releaseYear}) — already in DB`);
        } else {
          movieCandidates.push({ tmdbId: movieBest.tmdbId, title: movieBest.title, releaseYear: parseInt(movieBest.releaseYear) || null, sourceTitle: title });
          console.log(`[MOVIE] "${movieBest.title}" (${movieBest.releaseYear}) — new candidate`);
        }
      } else {
        stillUnresolved.push({ title, year });
        console.log(`[NONE] "${title}" (${year}) — no match on either TV or movie search`);
      }
    } catch (err) {
      stillUnresolved.push({ title, year, error: err.message });
      console.log(`[ERROR] "${title}" — ${err.message}`);
    }
    await sleep(200);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Genuinely episodic TV: ${tvCandidates.length}`);
  console.log(`Non-episodic → movie pipeline: ${movieCandidates.length}`);
  console.log(`Still unresolved: ${stillUnresolved.length}`);

  fs.writeFileSync(`${SCRATCH}/emmy-notfound-resolved.json`, JSON.stringify({ tvCandidates, movieCandidates, stillUnresolved }, null, 2));
  console.log('\nWritten to emmy-notfound-resolved.json');
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
