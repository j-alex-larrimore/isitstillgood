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

// loser slug -> winner slug. The winner keeps its own title and year; the
// loser's description and ISBN move across when the winner is missing them.
//
// Batch applied 2026-10-09 and removed from this list once done: the typo'd
// "The Lighting Thief", the "Level 4" graded reader, and the two stray
// Orwell Person records.
//
// This batch came out of catalogue-check.js's "one title is the other plus
// extra words" report: 37 candidates, 15 of them the same work under two
// titles. The other 22 are left alone on purpose — a collection named for
// the work it contains ("Billy Budd and Other Prose Pieces"), an omnibus
// ("Works (… Of Mice and Men …)"), and sequels whose titles extend the
// first ("The Perfect Run II") all look identical to this test.
const MEDIA_MERGES = [
  // Series volumes carrying the series name, against a bare-title import.
  // The keeper has the series metadata; the loser has the ISBN.
  { loser: 'the-waste-lands-1991',        winner: 'the-dark-tower-iii-the-waste-lands-1991' },
  { loser: 'wizard-and-glass-1997',       winner: 'the-dark-tower-iv-wizard-and-glass-1997' },
  { loser: 'siege-and-storm-2013',        winner: 'shadow-and-bone-siege-and-storm-2013' },
  { loser: 'the-well-of-ascension-2007',  winner: 'mistborn-the-well-of-ascension-2007' },
  // A long or original-language title against the common one.
  { loser: 'elementa-philosophica-de-cive-1647', winner: 'de-cive-1647' },
  { loser: 'the-reasonableness-of-christianity-as-delivered-in-the-scriptures-1695', winner: 'the-reasonableness-of-christianity-1695' },
  { loser: 'el-ingenioso-hidalgo-don-quixote-de-la-mancha-1605', winner: 'don-quixote-1605' },
  { loser: 'the-innocents-abroad-or-the-new-pilgrims-progress-1869', winner: 'the-innocents-abroad-1869' },
  { loser: 'confessions-of-felix-krull-confidence-man-1954', winner: 'confessions-of-felix-krull-1954' },
  { loser: 'nesnesiteln-lehkost-byt-the-unbearable-lightness-of-being-sonzai-no-taerarenai-karusa-japanese-edition-1984', winner: 'the-unbearable-lightness-of-being-1984' },
  // An edition or printing label that was imported as part of the title.
  { loser: 'fallen-angels-with-connections-1988', winner: 'fallen-angels-1988' },
  { loser: 'the-beautiful-and-the-damned-early-printing-1922', winner: 'the-beautiful-and-damned-1922' },
  { loser: 'tender-is-the-night-a-romance-1934', winner: 'tender-is-the-night-1934' },
  { loser: 'one-hundred-years-of-solitude-tie-in-edition-1967', winner: 'one-hundred-years-of-solitude-1967' },
  // Title truncated mid-parenthesis by the importer.
  { loser: 'what-would-joey-do-joey-pigza-books-2003', winner: 'what-would-joey-do-2003' },
];
// stray person name -> the record they should have been
const PERSON_MERGES = [];

const SELECT = {
  id: true, title: true, slug: true, description: true, isbn13: true,
  seriesName: true, seriesNumber: true,
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
  // short one is reliably a stub that restates the title.
  const takeDesc = (l.description || '').length > (w.description || '').length * 1.5;
  // Carry the ISBN when only the loser has one. A bare-title import often
  // holds the ISBN while the record with the series metadata does not, and
  // deleting it outright would lose the catalogue's only copy of it.
  const takeIsbn = !w.isbn13 && !!l.isbn13;
  console.log(`    description: ${(w.description || '').length} chars`
    + (takeDesc ? ` -> ${(l.description || '').length} (from the loser)` : ' (kept)'));
  console.log(`    isbn: ${w.isbn13 || 'none'}`
    + (takeIsbn ? ` -> ${l.isbn13} (from the loser)` : ' (kept)'));

  if (!APPLY) return;
  const sets = [], vals = [];
  if (takeDesc) { sets.push(`description = $${sets.length + 1}`); vals.push(l.description); }
  if (takeIsbn) { sets.push(`isbn13 = $${sets.length + 1}`); vals.push(l.isbn13); }
  if (sets.length) {
    // Raw SQL so the winner's @updatedAt is not restamped.
    await prisma.$executeRawUnsafe(
      `UPDATE "MediaItem" SET ${sets.join(', ')} WHERE id = $${sets.length + 1}`, ...vals, w.id);
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
