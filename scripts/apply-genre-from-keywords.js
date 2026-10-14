/**
 * Add a setting genre to existing movies AND TV shows, by asking TMDB which
 * titles carry the genre's keywords.
 *
 *   node scripts/apply-genre-from-keywords.js --genre=Cooking
 *   node scripts/apply-genre-from-keywords.js --genre=Cooking --apply
 *
 * Dry run unless --apply. Terms come from SETTING_GENRE_VOCAB in
 * src/lib/mediaHelpers.js, so the genre this writes is the same one new
 * imports get from settingGenresFor() and the two cannot drift.
 *
 * ── Why this asks TMDB instead of reading the catalogue ──────────────────
 * apply-setting-genres-tv.js walks our own rows and fetches
 * /tv/{id}/keywords for each. That is one request per title: 18,644 movies
 * and 10,882 shows is 29,526 requests, over an hour of rate-limited
 * calling, to find a few hundred matches.
 *
 * Inverted, it is about a hundred requests. TMDB can be asked which titles
 * carry a keyword (/discover with_keywords), so we page through the
 * keyword's titles and intersect those ids with ours. Same answer, two
 * orders of magnitude cheaper, and it cannot miss a title whose keywords
 * we failed to fetch.
 *
 * The cost is that it only finds titles already in the catalogue — but so
 * did the other one, since it started from our rows.
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { SETTING_GENRE_VOCAB } = require('../src/lib/mediaHelpers');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const genreArg = args.find(a => a.startsWith('--genre='));
const GENRE = genreArg ? genreArg.slice('--genre='.length) : null;
const MAX_PAGES = 25;                    // 500 titles per term per media type

if (!GENRE || !SETTING_GENRE_VOCAB[GENRE]) {
  console.error('Usage: node scripts/apply-genre-from-keywords.js --genre=<Genre> [--apply]');
  console.error('Known genres: ' + Object.keys(SETTING_GENRE_VOCAB).join(', '));
  process.exit(1);
}

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
if (!TOKEN) { console.error('TMDB_READ_ACCESS_TOKEN is not set'); process.exit(1); }
const H = { Authorization: 'Bearer ' + TOKEN };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tmdb(path) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://api.themoviedb.org/3' + path, { headers: H });
    if (r.ok) return r.json();
    // 429 is a rate limit and 5xx is theirs; both are worth another go.
    if (r.status < 500 && r.status !== 429) return null;
    await sleep(800 * Math.pow(2, i));
  }
  return null;
}

// The keyword has to match by name exactly. A search for "chef" also
// returns "chef de cuisine", "sous-chef" and so on, and pulling every
// loose match in would undo the precision the vocabulary was chosen for.
async function keywordId(term) {
  const j = await tmdb('/search/keyword?query=' + encodeURIComponent(term));
  const hit = (j?.results || []).find(k => k.name.toLowerCase() === term.toLowerCase());
  return hit ? hit.id : null;
}

async function titlesFor(id, kind) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await tmdb(`/discover/${kind}?with_keywords=${id}&sort_by=popularity.desc&page=${page}`);
    if (!j || !j.results?.length) break;
    for (const r of j.results) out.push({ tmdbId: String(r.id), name: r.title || r.name });
    if (page >= (j.total_pages || 1)) break;
    await sleep(120);
  }
  return out;
}

(async () => {
  const terms = SETTING_GENRE_VOCAB[GENRE];
  console.log(`${GENRE}: ${terms.length} keyword(s)${APPLY ? '' : ' — dry run, nothing will be written'}\n`);

  // tmdbId -> the terms that produced it, kept so the report can show why
  // a title matched and a wrong one is traceable to the term to drop.
  const movies = new Map(), shows = new Map();
  for (const term of terms) {
    const id = await keywordId(term);
    if (!id) { console.log(`  ${term.padEnd(20)} no such TMDB keyword — skipped`); continue; }
    const [m, t] = [await titlesFor(id, 'movie'), await titlesFor(id, 'tv')];
    const record = (map, x) => {
      if (!map.has(x.tmdbId)) map.set(x.tmdbId, { name: x.name, terms: [] });
      const entry = map.get(x.tmdbId);
      if (!entry.terms.includes(term)) entry.terms.push(term);
    };
    m.forEach(x => record(movies, x));
    t.forEach(x => record(shows, x));
    console.log(`  ${term.padEnd(20)} ${String(m.length).padStart(4)} films  ${String(t.length).padStart(4)} shows`);
    await sleep(120);
  }
  console.log(`\nTMDB knows ${movies.size} films and ${shows.size} shows carrying these keywords.`);

  const rows = [
    ...await prisma.mediaItem.findMany({
      where: { mediaType: 'MOVIE', tmdbId: { in: [...movies.keys()] } },
      select: { id: true, title: true, releaseYear: true, genres: true, tmdbId: true, mediaType: true },
    }),
    // Parent shows only. A season inherits its show's genres and tagging
    // each one would put the genre on the catalogue eight times over.
    ...await prisma.mediaItem.findMany({
      where: { mediaType: 'TV_SHOW', parentId: null, tmdbId: { in: [...shows.keys()] } },
      select: { id: true, title: true, releaseYear: true, genres: true, tmdbId: true, mediaType: true },
    }),
  ];
  const todo = rows.filter(r => !(r.genres || []).includes(GENRE));

  console.log(`In our catalogue: ${rows.length} of those (${rows.length - todo.length} already tagged ${GENRE}).\n`);
  todo.sort((a, b) => a.title.localeCompare(b.title)).forEach(r => {
    const why = (r.mediaType === 'MOVIE' ? movies : shows).get(r.tmdbId)?.terms || [];
    console.log(`  + ${r.mediaType === 'MOVIE' ? '🎬' : '📺'} ${(r.title + ' (' + (r.releaseYear || '—') + ')').padEnd(46)} ${why.join(', ')}`);
  });

  if (!APPLY) {
    console.log(`\nDry run. ${todo.length} title(s) would gain "${GENRE}" — re-run with --apply.`);
    await prisma.$disconnect();
    return;
  }
  for (const r of todo) {
    await prisma.mediaItem.update({
      where: { id: r.id },
      data: { genres: [...new Set([...(r.genres || []), GENRE])] },
    });
  }
  console.log(`\nTagged ${todo.length} title(s) with "${GENRE}".`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
