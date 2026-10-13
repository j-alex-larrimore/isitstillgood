/**
 * Find writers the catalogue has filed under more than one spelling of
 * their name, and fold the strays into one record.
 *
 *   node scripts/merge-author-variants.js                  # report only
 *   node scripts/merge-author-variants.js --apply          # merge the strong ones
 *   node scripts/merge-author-variants.js --apply --only=koontz
 *
 * Why this exists: an author page looked thin because the books were split,
 * not because they were missing. Dean Koontz sat across three Person rows —
 * "Dean Koontz", "Dean R. Koontz" and "Dean Ray Koontz" — because each
 * import trusted whatever name that edition's cover carried. Checking for
 * this is cheaper than importing a back catalogue, and it has to happen
 * first either way: importing into a split identity just makes a fourth.
 *
 * ── On not merging too eagerly ──────────────────────────────────────────
 * Names alone cannot settle this, and the failure is expensive and silent.
 * The catalogue contains, by first initial and surname:
 *
 *   E L James    vs  Eloisa James          — different writers
 *   John Green   vs  John Patrick Green    — different writers
 *   J. R. Ward   vs  Jesmyn Ward           — different writers
 *
 * all of which a "same initial, same surname" rule merges happily. So the
 * script grades its evidence and only acts on the kind that cannot be
 * coincidence:
 *
 *   STRONG  positional initial expansion across three or more names — every
 *           token lines up and each short one is the initial of the long
 *           one, so "R.L. Stine" and "Robert Lawrence Stine" are the same
 *           three names written twice. Three components is the threshold
 *           because two is not evidence of anything: "B. Smith" expands to
 *           "Betty Smith" by exactly the same rule, and to several thousand
 *           other people.
 *   STRONG  a shared title — two spellings credited on one identical book
 *           are one person, whatever the names look like.
 *   WEAK    a dropped middle name ("Dean Koontz" / "Dean Ray Koontz").
 *           Usually right, sometimes John Green. Reported, never applied
 *           without --only naming it.
 *
 * Weak matches are listed for a human to read. That is the point of them.
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { normalizeTitleForSearch } = require('../src/lib/mediaHelpers');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyArg = args.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).toLowerCase() : null;

const RELATIONS = ['_AuthoredBy', '_DirectedBy', '_AppearedIn'];

const parts = (n) => String(n || '').toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);

// "R.L. Stine" / "Robert Lawrence Stine": same number of names, each one
// either identical or an initial standing in for the other. At least one
// initial has to be doing that work, otherwise this is just equality — and
// at least three names, or "B. Smith" qualifies.
function initialExpansion(a, b) {
  const x = parts(a), y = parts(b);
  if (x.length !== y.length || x.length < 3) return false;
  let abbreviated = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    const short = x[i].length === 1 ? x[i] : y[i].length === 1 ? y[i] : null;
    const long = short === x[i] ? y[i] : x[i];
    if (!short || short[0] !== long[0]) return false;
    abbreviated++;
  }
  return abbreviated > 0;
}

// "B. Smith" / "Betty Smith" — exactly one abbreviated given name.
function initialFirstName(a, b) {
  const x = parts(a), y = parts(b);
  return x[1] === y[1] && x[0] !== y[0]
    && (x[0].length === 1 || y[0].length === 1) && x[0][0] === y[0][0];
}

// One name is the other with a middle name dropped. Same first and last,
// and the shorter one's tokens all appear in the longer in order.
function droppedMiddle(a, b) {
  const x = parts(a), y = parts(b);
  if (x.length === y.length) return false;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  if (s.length < 2 || s[0] !== l[0] || s[s.length - 1] !== l[l.length - 1]) return false;
  let i = 0;
  for (const tok of l) if (i < s.length && tok === s[i]) i++;
  return i === s.length;
}

(async () => {
  const people = await prisma.$queryRawUnsafe(`
    SELECT pe.id, pe.name, pe.slug,
           COUNT(DISTINCT r."A")::int AS books
    FROM "Person" pe
    JOIN "_AuthoredBy" r ON r."B" = pe.id
    GROUP BY pe.id, pe.name, pe.slug`);
  console.log(`${people.length} people with book credits\n`);

  // Bucketed by first initial + surname so this is one pass, not 3,949².
  const buckets = {};
  for (const p of people) {
    const n = parts(p.name);
    if (n.length < 2) continue;
    const key = n[0][0] + '|' + n[n.length - 1];
    (buckets[key] = buckets[key] || []).push(p);
  }

  const strong = [], weak = [];
  for (const group of Object.values(buckets)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        if (a.name === b.name) continue;
        if (initialExpansion(a.name, b.name)) strong.push({ a, b, why: 'initials' });
        else if (droppedMiddle(a.name, b.name)) weak.push({ a, b, why: 'middle name' });
        // "B. Smith" / "Betty Smith" — one initial and a surname. Reported
        // so it can be merged by hand, never acted on: it is the weakest
        // signal in the file and the surname is doing all the work.
        else if (parts(a.name).length === 2 && parts(b.name).length === 2
                 && initialFirstName(a.name, b.name)) weak.push({ a, b, why: 'first initial' });
      }
    }
  }

  // The other kind of proof: both spellings credited on the same book.
  // Checked only for the weak pairs, since it is what would promote them.
  for (const pair of weak) {
    const [ta, tb] = await Promise.all([pair.a, pair.b].map(p =>
      prisma.mediaItem.findMany({
        where: { authors: { some: { id: p.id } } }, select: { title: true },
      })));
    const seen = new Set(ta.map(t => normalizeTitleForSearch(t.title)));
    const shared = tb.map(t => t.title).filter(t => seen.has(normalizeTitleForSearch(t)));
    if (shared.length) { pair.why = `shares "${shared[0]}"`; strong.push(pair); pair.promoted = true; }
  }
  const stillWeak = weak.filter(p => !p.promoted);

  const match = (p) => !ONLY || (p.a.name + ' ' + p.b.name).toLowerCase().includes(ONLY);
  const doing = strong.filter(match);
  const forced = ONLY ? stillWeak.filter(match) : [];

  console.log(`── Confident (${strong.length}) ─────────────────────────────────`);
  strong.forEach(p => console.log(
    `  ${p.a.name} (${p.a.books}) + ${p.b.name} (${p.b.books})  — ${p.why}`));
  console.log(`\n── Needs a human (${stillWeak.length}) ──────────────────────────`);
  console.log('  Same surname and first initial, one has a middle name. Some of');
  console.log('  these are two different writers. Merge with --only=<substring>.');
  stillWeak.forEach(p => console.log(
    `  ${p.a.name} (${p.a.books}) ?= ${p.b.name} (${p.b.books})`));

  // Three spellings of one writer produce three pairs, and merging them
  // one at a time would delete a record the next pair still points at.
  // Collapse the accepted pairs into connected groups first, then each
  // group resolves to a single survivor.
  const edges = [...doing, ...forced];
  const home = new Map();
  const find = (id) => (home.get(id) === id ? id : (home.set(id, find(home.get(id))), home.get(id)));
  for (const e of edges) for (const p of [e.a, e.b]) if (!home.has(p.id)) home.set(p.id, p.id);
  for (const e of edges) home.set(find(e.a.id), find(e.b.id));

  const clusters = new Map();
  for (const e of edges) for (const p of [e.a, e.b]) {
    const root = find(p.id);
    if (!clusters.has(root)) clusters.set(root, new Map());
    clusters.get(root).set(p.id, p);
  }
  const todo = [...clusters.values()].map(m => [...m.values()]);

  if (!APPLY) {
    const n = todo.reduce((s, c) => s + c.length - 1, 0);
    console.log(`\nDry run. ${n} record(s) would be folded into ${todo.length} writer(s) — re-run with --apply.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\nMerging ${todo.length} writer(s)…`);
  for (const cluster of todo) {
    // The fuller record wins on credits, not on name length: whichever
    // spelling the catalogue already uses most is the one its slugs,
    // existing reviews and inbound links already point at.
    // On a tie the credit count says nothing, so fall back to which
    // spelling reads better: full given names over initials, and never a
    // name with a token repeated twice running ("Ernest Alfred Ernest
    // Alfred Vizetelly" is a mangled import, not a preference).
    const quality = (p) => {
      const n = parts(p.name);
      const repeated = n.some((t, i) => i > 0 && t === n[i - 1]) ? -10 : 0;
      const cased = /[A-Z]/.test(p.name) ? 1 : 0;
      return repeated + cased + n.filter(t => t.length > 1).length;
    };
    const ranked = [...cluster].sort((x, y) => (y.books - x.books) || (quality(y) - quality(x)));
    const keep = ranked[0];
    for (const drop of ranked.slice(1)) {
    let moved = 0;
    for (const rel of RELATIONS) {
      // Repointing the join row leaves MediaItem.updatedAt alone, which is
      // right: correcting an author's spelling is not a change to the book.
      // ON CONFLICT covers the case where both spellings are already on the
      // same item — the duplicate credit is dropped rather than erroring.
      const n = await prisma.$executeRawUnsafe(
        `UPDATE "${rel}" SET "B" = $1 WHERE "B" = $2
           AND NOT EXISTS (SELECT 1 FROM "${rel}" k WHERE k."A" = "${rel}"."A" AND k."B" = $1)`,
        keep.id, drop.id);
      const leftover = await prisma.$executeRawUnsafe(`DELETE FROM "${rel}" WHERE "B" = $1`, drop.id);
      moved += n + leftover;
    }
    await prisma.person.delete({ where: { id: drop.id } });
    console.log(`  ✓ ${drop.name} → ${keep.name} (${moved} credit(s))`);
    }
  }

  console.log('\nDone.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
