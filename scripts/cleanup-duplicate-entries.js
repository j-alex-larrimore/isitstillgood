/**
 * One-off: three duplicate records found while stripping PDF spam from book
 * descriptions (see scripts/strip-pdf-spam.js).
 *
 *   node scripts/cleanup-duplicate-entries.js            # dry run
 *   node scripts/cleanup-duplicate-entries.js --apply
 *
 * 1. "The Lighting Thief" (2022) — a typo'd second copy of The Lightning
 *    Thief. Renaming it would have produced two correctly-titled duplicates,
 *    so the loser is deleted. It had the only real synopsis of the two
 *    (470 chars against a 63-char restatement of the title), so that moves
 *    across before it goes.
 *
 * 2. "Nineteen Eighty-Four (Penguin Readers Level 4)" — imported as the
 *    bare title "Level 4", which is the graded-reader level, not a work.
 *    Retitled already; it is still a second entry for a book the catalogue
 *    carries properly, and the canonical record is richer, so nothing is
 *    worth keeping from it.
 *
 * 3. "G Orwell" and "George Orwel" — importer-made Person records sitting
 *    alongside "George Orwell" on the same omnibus. connectPersons upserts
 *    by slugified name, so these three never collapse on their own.
 *
 * Deletions are only ever performed on records with no reviews, no list
 * entries and no pending imports; the script re-checks that at write time
 * rather than trusting this comment.
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const APPLY = process.argv.includes('--apply');

// loser slug -> winner slug. The winner keeps its own title, year and ISBN.
const MEDIA_MERGES = [
  { loser: 'the-lighting-thief-2022', winner: 'the-lightning-thief-2006' },
  { loser: 'level-4-2003', winner: 'nineteen-eighty-four-1949' },
];
// stray person name -> the record they should have been
const PERSON_MERGES = [
  { from: 'G Orwell', into: 'George Orwell' },
  { from: 'George Orwel', into: 'George Orwell' },
];

const SELECT = {
  id: true, title: true, slug: true, description: true,
  _count: { select: { reviews: true, listItems: true, pendingImports: true, seasonEntries: true } },
};

async function mergeMedia({ loser, winner }) {
  const l = await prisma.mediaItem.findFirst({ where: { slug: loser }, select: SELECT });
  const w = await prisma.mediaItem.findFirst({ where: { slug: winner }, select: SELECT });
  if (!l) return console.log(`  skip — no such item: ${loser}`);
  if (!w) return console.log(`  skip — no such item: ${winner}`);

  const refs = l._count;
  const blocked = refs.reviews || refs.listItems || refs.pendingImports || refs.seasonEntries;
  console.log(`  "${l.title}" (${l.slug})  ->  "${w.title}" (${w.slug})`);
  console.log(`    loser refs: ${JSON.stringify(refs)}`);
  if (blocked) return console.log('    REFUSED — something points at it; merge those by hand first');

  // Keep the better description. "Better" here only ever means longer: the
  // short one in both cases is a stub that restates the title.
  const takeDesc = (l.description || '').length > (w.description || '').length * 1.5;
  console.log(`    description: ${(w.description || '').length} chars`
    + (takeDesc ? ` -> ${(l.description || '').length} (taken from the loser)` : ' (kept)'));

  if (!APPLY) return;
  if (takeDesc) {
    // Raw SQL so the winner's @updatedAt is not restamped.
    await prisma.$executeRawUnsafe(
      'UPDATE "MediaItem" SET description = $1 WHERE id = $2', l.description, w.id);
  }
  await prisma.mediaItem.delete({ where: { id: l.id } });
  console.log('    deleted the loser');
}

async function mergePerson({ from, into }) {
  const a = await prisma.person.findFirst({
    where: { name: from }, select: { id: true, name: true, slug: true, authored: { select: { id: true, title: true } } } });
  const b = await prisma.person.findFirst({ where: { name: into }, select: { id: true, name: true, slug: true } });
  if (!a) return console.log(`  skip — no such person: ${from}`);
  if (!b) return console.log(`  skip — no such person: ${into}`);
  console.log(`  "${a.name}" (${a.slug}) -> "${b.name}" (${b.slug});`
    + ` ${a.authored.length} book(s): ${a.authored.map(x => x.title).join(', ') || 'none'}`);
  if (!APPLY) return;
  // connect is additive and a no-op where the pair already exists, so a book
  // credited to both names does not end up with a duplicate join row.
  for (const item of a.authored) {
    await prisma.mediaItem.update({ where: { id: item.id }, data: { authors: { connect: { id: b.id } } } });
  }
  await prisma.person.delete({ where: { id: a.id } });
  console.log('    merged and removed the stray record');
}

(async () => {
  console.log(APPLY ? 'APPLYING\n' : 'DRY RUN — nothing is written\n');
  console.log('Duplicate media items:');
  for (const m of MEDIA_MERGES) await mergeMedia(m);
  console.log('\nDuplicate people:');
  for (const p of PERSON_MERGES) await mergePerson(p);
  console.log(APPLY ? '\nDone.' : '\nRe-run with --apply to write.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
