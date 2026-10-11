/**
 * Read-only sweep for the two duplicate shapes the importers keep producing.
 *
 *   node scripts/catalogue-check.js              # everything
 *   node scripts/catalogue-check.js --media      # just media items
 *   node scripts/catalogue-check.js --people     # just Person records
 *   node scripts/catalogue-check.js --limit 40   # per-section cap (default 25)
 *
 * Why it exists: "The Lighting Thief" sat beside "The Lightning Thief" for
 * months, and "G Orwell" / "George Orwel" sat beside "George Orwell" on the
 * same omnibus. Neither collapses on its own — connectPersons upserts a
 * Person by slugified name, and bulk-import matches an existing MediaItem by
 * external id first and exact title second, so one transposed letter makes a
 * second record every time.
 *
 * Nothing here writes. It prints candidates; scripts/cleanup-duplicate-
 * entries.js is the thing that merges, and only for records with no reviews,
 * list entries or pending imports.
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const args = process.argv.slice(2);
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 25;
const only = args.includes('--media') ? 'media' : args.includes('--people') ? 'people' : 'all';

/* Edit distance, bailed out early — we only ever care about 0, 1 or 2. */
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;      // whole row already too far
    prev = cur;
  }
  return prev[b.length] <= max;
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const line = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

async function media() {
  line('Media items sharing an ISBN');
  const isbn = await prisma.$queryRawUnsafe(`
    SELECT isbn13, COUNT(*)::int n, array_agg(title || '  [' || slug || ']') titles
    FROM "MediaItem" WHERE isbn13 IS NOT NULL
    GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT ${LIMIT}`);
  if (!isbn.length) console.log('  none');
  isbn.forEach(r => { console.log(`  ${r.isbn13}  x${r.n}`); r.titles.forEach(t => console.log(`     ${t}`)); });

  line('Media items with an identical title and type');
  const same = await prisma.$queryRawUnsafe(`
    SELECT "normalizedTitle", "mediaType", COUNT(*)::int n,
           array_agg(title || ' (' || COALESCE("releaseYear"::text,'?') || ')  [' || slug || ']') titles
    FROM "MediaItem" WHERE "normalizedTitle" IS NOT NULL AND "normalizedTitle" <> ''
    GROUP BY 1,2 HAVING COUNT(*) > 1 ORDER BY 3 DESC LIMIT ${LIMIT}`);
  if (!same.length) console.log('  none');
  same.forEach(r => { console.log(`  "${r.normalizedTitle}" ${r.mediaType} x${r.n}`); r.titles.forEach(t => console.log(`     ${t}`)); });

  line('Near-identical titles sharing a creator (the Lighting Thief shape)');
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, title, slug, "mediaType", "releaseYear", "normalizedTitle"
    FROM "MediaItem" WHERE "normalizedTitle" IS NOT NULL AND length("normalizedTitle") >= 6`);
  // Bucket first — 70k items will not survive an all-pairs comparison. A
  // one-letter slip almost never lands in the first six characters, and when
  // it does the second bucket (last six) catches it.
  const buckets = new Map();
  const put = (k, r) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(r); };
  for (const r of rows) {
    put(r.mediaType + '|a|' + r.normalizedTitle.slice(0, 6), r);
    put(r.mediaType + '|b|' + r.normalizedTitle.slice(-6), r);
  }
  const seen = new Set(), pairs = [];
  for (const group of buckets.values()) {
    if (group.length < 2 || group.length > 400) continue;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const [a, b] = [group[i], group[j]];
      if (a.normalizedTitle === b.normalizedTitle) continue;   // already reported above
      const key = a.id < b.id ? a.id + b.id : b.id + a.id;
      if (seen.has(key)) continue;
      if (!within(a.normalizedTitle, b.normalizedTitle, 2)) continue;
      seen.add(key); pairs.push([a, b]);
    }
  }
  // Only report a pair that shares a creator; without that, near-identical
  // titles are mostly unrelated works ("The Gift" / "The Grift").
  //
  // Creators for every candidate in one round trip. Asking per pair meant a
  // query for each of thousands of candidates, which did not finish.
  const ids = [...new Set(pairs.flatMap(([a, b]) => [a.id, b.id]))];
  const creators = new Map();
  if (ids.length) {
    const links = await prisma.$queryRawUnsafe(`
      SELECT j."A" id, p.name FROM (
        SELECT "A","B" FROM "_AuthoredBy" UNION ALL SELECT "A","B" FROM "_DirectedBy"
      ) j JOIN "Person" p ON p.id = j."B"
      WHERE j."A" = ANY($1::text[])`, ids);
    for (const l of links) {
      if (!creators.has(l.id)) creators.set(l.id, new Set());
      creators.get(l.id).add(l.name);
    }
  }
  let shown = 0;
  for (const [a, b] of pairs) {
    if (shown >= LIMIT) break;
    const na = creators.get(a.id) || new Set(), nb = creators.get(b.id) || new Set();
    const shared = [...na].filter(n => nb.has(n));
    if (!shared.length) continue;
    shown++;
    console.log(`  "${a.title}" (${a.releaseYear}) [${a.slug}]`);
    console.log(`  "${b.title}" (${b.releaseYear}) [${b.slug}]`);
    console.log(`     shared: ${shared.join(', ')}\n`);
  }
  if (!shown) console.log(`  none (${pairs.length} near-identical pairs, none sharing a creator)`);

  // The edit-distance check above only catches a slip of a letter or two.
  // It misses the commoner shape entirely, because the two titles are not
  // close at all: "The Lightning Thief" against "The Percy Jackson and the
  // Olympians, Book One: Lightning Thief". Every meaningful word of the
  // shorter title is present in the longer one, which is the tell.
  //
  // Restricted hard — same type, same release year, a shared creator — and
  // still not proof. An omnibus legitimately contains a work's title
  // ("Works (Leader of the People / Of Mice and Men / ...)"), and a sequel
  // legitimately extends one ("The Boss Baby and Tim's Treasure Hunt"). So
  // this reports; it never merges.
  line('One title is the other plus extra words (same creator and year)');
  const STOP = new Set(['the','a','an','and','of','or','in','on','to','for',
                        'book','vol','volume','part','one','two','three','series']);
  // Digits are kept. Dropping them as noise collapsed "Henry VI, Part 2"
  // and "Henry VI, Part 3" to the same {henry, vi} and reported two
  // different plays as one work. A number is often the only thing telling
  // two titles apart, which makes it the last token to throw away.
  const toks = (t) => new Set((t || '').split(' ').filter(w => w && !STOP.has(w)));
  const subset = await prisma.$queryRawUnsafe(`
    WITH c AS (SELECT "A" mid,"B" pid FROM "_AuthoredBy"
               UNION ALL SELECT "A","B" FROM "_DirectedBy")
    SELECT DISTINCT a.title ta, a.slug sa, a."normalizedTitle" na,
                    b.title tb, b.slug sb, b."normalizedTitle" nb,
                    a."mediaType" mt, a."releaseYear" yr
    FROM "MediaItem" a JOIN c ca ON ca.mid = a.id
    JOIN c cb ON cb.pid = ca.pid AND cb.mid <> a.id
    JOIN "MediaItem" b ON b.id = cb.mid
    WHERE a."mediaType" = b."mediaType" AND a.id < b.id
      AND a."releaseYear" IS NOT DISTINCT FROM b."releaseYear"`);
  let subShown = 0, subTotal = 0;
  for (const r of subset) {
    const A = toks(r.na), B = toks(r.nb);
    if (!A.size || !B.size) continue;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    if (small.size < 2 || small.size === big.size) continue;
    if (![...small].every(w => big.has(w))) continue;
    subTotal++;
    if (subShown++ >= LIMIT) continue;
    console.log(`  [${r.mt} ${r.yr}] "${r.ta}"  [${r.sa}]`);
    console.log(`                 vs "${r.tb}"  [${r.sb}]`);
  }
  if (!subTotal) console.log('  none');
  else if (subTotal > LIMIT) console.log(`  … ${subTotal - LIMIT} more — raise --limit`);
}

async function people() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT p.id, p.name, p.slug,
      (SELECT COUNT(*)::int FROM "_AuthoredBy" x WHERE x."B"=p.id)
      + (SELECT COUNT(*)::int FROM "_AppearedIn" x WHERE x."B"=p.id)
      + (SELECT COUNT(*)::int FROM "_DirectedBy" x WHERE x."B"=p.id) credits
    FROM "Person" p`);
  console.log(`\n(${rows.length} Person records)`);

  // Bucket on the last word — a slip is far likelier in a forename, and an
  // initial-vs-forename pair ("G Orwell") shares the surname by definition.
  const bySurname = new Map();
  for (const r of rows) {
    const n = norm(r.name); if (!n) continue;
    r.n = n; r.parts = n.split(' ');
    const k = r.parts[r.parts.length - 1];
    if (!bySurname.has(k)) bySurname.set(k, []);
    bySurname.get(k).push(r);
  }

  const hits = [];
  for (const group of bySurname.values()) {
    if (group.length < 2 || group.length > 60) continue;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const [a, b] = [group[i], group[j]];
      if (a.n === b.n) { hits.push(['same name once punctuation is dropped', a, b]); continue; }
      // "G Orwell" against "George Orwell"
      const initial = a.parts.length === b.parts.length
        && a.parts.every((p, k) => p === b.parts[k]
            || (p.length === 1 && b.parts[k].startsWith(p))
            || (b.parts[k].length === 1 && p.startsWith(b.parts[k])));
      if (initial) { hits.push(['initial vs full forename', a, b]); continue; }
      if (within(a.n, b.n, 1)) hits.push(['one letter apart', a, b]);
    }
  }

  // Credits for every candidate in one round trip, same reason as above.
  const pids = [...new Set(hits.flatMap(([, a, b]) => [a.id, b.id]))];
  const credits = new Map();
  if (pids.length) {
    const links = await prisma.$queryRawUnsafe(`
      SELECT "B" pid, "A" mid FROM "_AuthoredBy" WHERE "B" = ANY($1::text[])
      UNION SELECT "B", "A" FROM "_AppearedIn" WHERE "B" = ANY($1::text[])
      UNION SELECT "B", "A" FROM "_DirectedBy" WHERE "B" = ANY($1::text[])`, pids);
    for (const l of links) {
      if (!credits.has(l.pid)) credits.set(l.pid, new Set());
      credits.get(l.pid).add(l.mid);
    }
  }

  const scored = hits.map(([why, a, b]) => {
    const ca = credits.get(a.id) || new Set(), cb = credits.get(b.id) || new Set();
    // A stray importer record is nearly always the lopsided one: "R. Peck"
    // with 1 credit beside "Richard Peck" with 35. Two real people with
    // similar names usually both have a career.
    const lop = Math.max(a.credits, b.credits) / Math.max(1, Math.min(a.credits, b.credits));
    return { why, a, b, overlap: [...ca].filter(x => cb.has(x)).length, lop };
  });

  // Grouped by what the evidence is actually worth, because it varies a lot.
  // "One letter apart" looks damning until you notice Rakesh and Rajesh
  // Roshan are brothers who work on the same films, and Maria and Marta
  // Aura are mother and daughter — for cast, a shared title is not proof.
  // Punctuation-only and initial-vs-forename differences are far safer.
  const GROUPS = [
    ['Same name once punctuation is dropped (safe to merge)', (h) => h.why.startsWith('same name')],
    ['An initial against a full forename (usually one person)', (h) => h.why.startsWith('initial')],
    ['One letter apart (CHECK: siblings and co-stars land here)', (h) => h.why.startsWith('one letter')],
  ];
  for (const [heading, pick] of GROUPS) {
    const rows = scored.filter(pick).sort((x, y) => (y.overlap - x.overlap) || (y.lop - x.lop));
    line(heading);
    if (!rows.length) { console.log('  none'); continue; }
    rows.slice(0, LIMIT).forEach(({ a, b, overlap, lop }) => {
      console.log(`  "${a.name}" (${a.credits}) vs "${b.name}" (${b.credits})`
        + (overlap ? `  share ${overlap} title(s)` : '')
        + (lop >= 5 ? '  lopsided' : ''));
    });
    if (rows.length > LIMIT) console.log(`  … ${rows.length - LIMIT} more — raise --limit`);
  }
  console.log(`\n  ${scored.length} candidate pair(s) in total`);
}

(async () => {
  if (only !== 'people') await media();
  if (only !== 'media') await people();
  console.log('\nNothing was changed. scripts/cleanup-duplicate-entries.js does the merging.\n');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
