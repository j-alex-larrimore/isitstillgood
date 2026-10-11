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
const { normalizeTitleForSearch } = require('../src/lib/mediaHelpers');

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
// Open Library part-files: one physical volume of a long novel imported as
// its own book, titled "[3/5]" and so on. The whole work is already in the
// catalogue in every case but one, which is renamed rather than deleted.
const VOLUME_SPLITS = [
  { loser: 'david-copperfield-12-1850',   winner: 'david-copperfield-1850' },
  { loser: 'emma-23-1816',                winner: 'emma-1816' },
  { loser: 'little-dorrit-12-1857',       winner: 'little-dorrit-1857' },
  { loser: 'madame-bovary-22-1857',       winner: 'madame-bovary-1857' },
  { loser: 'martin-chuzzlewit-22-1844',   winner: 'martin-chuzzlewit-1844' },
  { loser: 'nicholas-nickleby-1-1839',    winner: 'nicholas-nickleby-1839' },
  { loser: 'oliver-twist-33-1838',        winner: 'oliver-twist-1838' },
  { loser: 'the-marble-faun-12-1860',     winner: 'the-marble-faun-1860' },
  { loser: 'the-pickwick-papers-35-1837', winner: 'the-pickwick-papers-1837' },
  { loser: 'wuthering-heights-22-1847',   winner: 'wuthering-heights-1847' },
];
// No whole-work record exists for this one, so deleting it would drop the
// book from the catalogue entirely. It gets its split marker stripped.
const RENAMES = [
  { slug: 'our-mutual-friend-12-1865', title: 'Our Mutual Friend' },
];

// One ISBN on two different works. Each was resolved by asking Open Library
// what the ISBN actually is; the record it names keeps it and the other is
// cleared. Two of them turned out to be box-set ISBNs belonging to neither
// individual book, so both sides are cleared.
const ISBN_CLEARS = [
  { slug: 'magnolia-table-2018',                        was: '9780062820181', real: 'Magnolia Table Vol 2' },
  { slug: 'the-blood-sugar-solution-2012',              was: '9780316338813', real: 'The blood sugar solution 10-day detox diet cookbook' },
  { slug: 'crown-of-stars-2006',                        was: '9780886777715', real: "King's Dragon (Crown of Stars, Vol. 1)" },
  { slug: 'of-dawn-and-darkness-2015',                  was: '9780989671743', real: 'Of Darkness and Dawn' },
  { slug: 'of-shadow-and-sea-2015',                     was: '9780999851159', real: 'Of Sea and Shadow' },
  { slug: 'grey-2015',                                  was: '9781523849918', real: 'Fifty Shades of Grey' },
  { slug: 'the-disinherited-prince-2016',               was: '9781548052232', real: 'The Misplaced Prince (Volume 6)' },
  { slug: 'harry-potter-and-the-philosophers-stone-1997', was: '9781551927282', real: 'Harry Potter and the Chamber of Secrets' },
  // 560 pages, Top Shelf — the collected trilogy, not the 2013 first volume.
  { slug: 'march-book-one-2013',                        was: '9781603093958', real: 'March (collected, 560pp)' },
  { slug: 'the-walking-dead-compendium-2012',           was: '9781607060765', real: 'The Walking Dead, Compendium One (2009)' },
  { slug: 'of-kings-and-killers-2020',                  was: '9781734958102', real: 'Of Killers and Kings' },
  { slug: 'the-20-2014',                                was: '9781939457318', real: 'The 20/20 Diet' },
  { slug: 'fantastic-beasts-where-to-find-them-2015',   was: '9798855115468', real: 'Fantastic Beasts and Where to Find Them (2001 record)' },
  // Box sets — the ISBN is the collection's, not either book's.
  { slug: 'the-bone-ships-wake-2021',                   was: '9781637995907', real: 'Tide Child Trilogy 3-book set' },
  { slug: 'call-of-the-bone-ships-2020',                was: '9781637995907', real: 'Tide Child Trilogy 3-book set' },
  { slug: 'diary-of-a-wimpy-kid-the-meltdown-2020',     was: '9781637996959', real: 'Wimpy Kid 11-19 9-book set' },
  { slug: 'hot-mess-diary-of-a-wimpy-kid-book-19-2024', was: '9781637996959', real: 'Wimpy Kid 11-19 9-book set' },
];

const MEDIA_MERGES = [
  // Same book twice, found via a shared ISBN rather than a similar title.
  { loser: 'taken-robert-crais-2012', winner: 'taken-2012' },
  { loser: 'a-spy-among-friends-2014', winner: 'a-spy-among-friends-kim-philby-and-the-great-betrayal-2015' },
  { loser: 'freakonomics-2009', winner: 'freakonomics-2005' },
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

async function renameItem({ slug, title }) {
  const m = await prisma.mediaItem.findFirst({ where: { slug }, select: { id: true, title: true } });
  if (!m) return console.log(`  skip — no such item: ${slug}`);
  if (m.title === title) return console.log(`  already named "${title}"`);
  console.log(`  "${m.title}"  ->  "${title}"  [${slug}]`);
  if (!APPLY) return;
  // normalizedTitle is only kept in sync on the app's own write paths, so a
  // direct update has to maintain it or the item drops out of search.
  await prisma.$executeRawUnsafe(
    'UPDATE "MediaItem" SET title = $1, "normalizedTitle" = $2 WHERE id = $3',
    title, normalizeTitleForSearch(title), m.id);
}

async function clearIsbn({ slug, was, real }) {
  const m = await prisma.mediaItem.findFirst({ where: { slug }, select: { id: true, title: true, isbn13: true } });
  if (!m) return console.log(`  skip — no such item: ${slug}`);
  if (m.isbn13 !== was) return console.log(`  skip — "${m.title}" no longer holds ${was} (has ${m.isbn13 || 'none'})`);
  console.log(`  "${m.title}" loses ${was} — that ISBN is ${real}`);
  if (!APPLY) return;
  await prisma.$executeRawUnsafe('UPDATE "MediaItem" SET isbn13 = NULL WHERE id = $1', m.id);
}

(async () => {
  console.log(APPLY ? 'APPLYING\n' : 'DRY RUN — nothing is written\n');
  console.log('Duplicate media items:');
  for (const m of MEDIA_MERGES) await mergeMedia(m);
  console.log('\nVolume splits folded into the whole work:');
  for (const m of VOLUME_SPLITS) await mergeMedia(m);
  console.log('\nRenames:');
  for (const r of RENAMES) await renameItem(r);
  console.log('\nISBNs on the wrong record:');
  for (const c of ISBN_CLEARS) await clearIsbn(c);
  console.log('\nDuplicate people:');
  for (const p of PERSON_MERGES) await mergePerson(p);
  console.log(APPLY ? '\nDone.' : '\nRe-run with --apply to write.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
