// Fills MediaItem.imdbId for movies and TV parent rows from TMDB.
//
//   node scripts/backfill-imdb-ids.js [--limit N] [--type movie|tv] [--dry-run]
//
// Why this exists: the IMDb ratings importer (src/routes/imports.js) matches a
// user's exported CSV on the `tt…` id in its Const column. Without that, it
// would fall back to title+year, which is the one part of the Letterboxd
// importer that still mismatches occasionally. With it, matching is an exact
// key lookup.
//
// Nothing here talks to IMDb. TMDB publishes the IMDb id for its own records
// in /external_ids, and this project already reads TMDB under its API terms;
// the id is a join key, not IMDb content. IMDb *ratings* remain deliberately
// unstored — see the comment on tmdbId in prisma/schema.prisma.
//
// Safe to stop and re-run. Rows that already have an imdbId are skipped by the
// query itself, so progress is the database. The one thing that needs
// remembering between runs is which items TMDB has no IMDb id for at all —
// otherwise every run would retry the same few thousand dead ends — so those
// go in a checkpoint file next to this script.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');
const prisma = require('../src/lib/prisma');

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
const CHECKPOINT = path.join(__dirname, '_imdb-backfill-checkpoint.json');

// TMDB asks for reasonable use rather than publishing a hard ceiling. Eight in
// flight finishes the whole catalogue in about ten minutes and has never drawn
// a 429 in testing; raising it buys little and risks the whole run.
const CONCURRENCY = 8;
// One UPDATE ... FROM (VALUES ...) per batch instead of 29,000 round trips to
// a remote database. At one update per row this script took longer to write
// than to fetch.
const WRITE_BATCH = 500;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(args[limitArg + 1], 10) : null;
const typeArg = args.indexOf('--type');
const ONLY = typeArg > -1 ? args[typeArg + 1] : null;

const loadCheckpoint = () => {
  try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).none); }
  catch { return new Set(); }
};
const saveCheckpoint = none =>
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ none: [...none] }, null, 0));

async function externalImdbId(tmdbId, kind) {
  const res = await fetch(
    `https://api.themoviedb.org/3/${kind}/${tmdbId}/external_ids`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  if (res.status === 429) return { retry: true };
  // A 404 means TMDB has dropped or merged the record. Not an error worth
  // stopping for, but not a dead end to memoize either — it may come back.
  if (!res.ok) return { error: res.status };
  const json = await res.json();
  const id = (json.imdb_id || '').trim();
  return { imdbId: /^tt\d+$/.test(id) ? id : null };
}

// Writes a whole batch in one statement. Prisma has no updateMany with
// per-row values, so this is the raw equivalent, parameterized.
//
// Retried, because Railway's public Postgres proxy closes long-lived
// connections and a run over the full catalogue takes long enough to hit
// that: the first attempt at this dropped at ~23,000 of 29,456 with
// `Error in PostgreSQL connection: Error { kind: Closed }`. Losing the run
// was survivable (progress is the database, so a re-run resumes) but
// pointless — Prisma reconnects on the next query, so one retry is enough.
async function writeBatch(pairs, attempt = 0) {
  if (!pairs.length || DRY) return 0;
  const values = Prisma.join(
    pairs.map(p => Prisma.sql`(${p.id}, ${p.imdbId})`)
  );
  try {
    return await prisma.$executeRaw`
      UPDATE "MediaItem" AS m
         SET "imdbId" = v.imdb_id
        FROM (VALUES ${values}) AS v(id, imdb_id)
       WHERE m.id = v.id
    `;
  } catch (err) {
    if (attempt >= 2) throw err;
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    return writeBatch(pairs, attempt + 1);
  }
}

(async () => {
  if (!TOKEN) {
    console.error('TMDB_READ_ACCESS_TOKEN is not set. Copy it from Railway’s Variables tab into .env.');
    process.exit(1);
  }

  const none = loadCheckpoint();

  // Movies: every row. TV: parent rows only — IMDb rates a show as a whole, so
  // a season row has no id of its own and the importer never looks for one.
  const where = {
    imdbId: null,
    OR: [
      ...(ONLY === 'tv' ? [] : [{ mediaType: 'MOVIE' }]),
      ...(ONLY === 'movie' ? [] : [{ mediaType: 'TV_SHOW', parentId: null }]),
    ],
    tmdbId: { not: null },
  };

  const todo = await prisma.mediaItem.findMany({
    where,
    select: { id: true, tmdbId: true, mediaType: true, title: true },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  const queue = todo.filter(m => !none.has(`${m.mediaType}:${m.tmdbId}`));
  const already = await prisma.mediaItem.count({
    where: { imdbId: { not: null } },
  });

  console.log(`${todo.length} without an IMDb id · ${todo.length - queue.length} known to have none upstream · ${queue.length} to fetch`);
  console.log(`${already} already populated${DRY ? '   [DRY RUN — no writes]' : ''}\n`);
  if (!queue.length) { await prisma.$disconnect(); return; }

  let found = 0, missing = 0, errors = 0, processed = 0;
  let pending = [];
  let cursor = 0;
  let stop = null;

  async function worker() {
    while (cursor < queue.length && !stop) {
      const item = queue[cursor++];
      const kind = item.mediaType === 'MOVIE' ? 'movie' : 'tv';
      let r;
      try {
        r = await externalImdbId(item.tmdbId, kind);
      } catch (err) {
        errors++; processed++;
        continue;
      }

      if (r.retry) {
        // Backing off rather than hammering. One pause is enough in practice;
        // if it recurs the run is better stopped than throttled all the way.
        await new Promise(res => setTimeout(res, 5000));
        cursor--;
        continue;
      }
      if (r.error) { errors++; processed++; continue; }

      if (r.imdbId) {
        pending.push({ id: item.id, imdbId: r.imdbId });
        found++;
      } else {
        none.add(`${item.mediaType}:${item.tmdbId}`);
        missing++;
      }
      processed++;

      if (pending.length >= WRITE_BATCH) {
        const batch = pending; pending = [];
        await writeBatch(batch);
        saveCheckpoint(none);
      }
      if (processed % 1000 === 0) {
        console.log(`  ${processed}/${queue.length} · found ${found} · none upstream ${missing}${errors ? ` · errors ${errors}` : ''}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (pending.length) await writeBatch(pending);
  saveCheckpoint(none);

  const total = await prisma.mediaItem.count({ where: { imdbId: { not: null } } });
  const eligible = await prisma.mediaItem.count({
    where: { OR: [{ mediaType: 'MOVIE' }, { mediaType: 'TV_SHOW', parentId: null }] },
  });
  console.log(`\nprocessed ${processed} · found ${found} · no imdb id upstream ${missing} · errors ${errors}`);
  console.log(`items with an IMDb id: ${total}/${eligible} (${(total / eligible * 100).toFixed(1)}%)`);

  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
