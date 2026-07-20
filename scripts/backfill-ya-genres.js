// Re-derives genres for Open-Library-sourced books using their full subject
// list, to pick up "Young Adult" / "Children's" / "Coming of Age" tags that
// were lost at import time.
//
// Root cause: filterOpenLibraryGenres() in src/services/mediaLookup.js used
// to blocklist any subject containing "juvenile", "young adult fiction", or
// "children" as noise, before normalizeBookGenres() ever got a chance to map
// those subjects to canonical genres. That blocklist has been fixed, but
// books already in the DB were imported with the old, stripped-down subject
// list baked into their stored genres — the raw signal is gone from the DB
// row and has to be re-fetched from Open Library to recover it.
//
// Additive only: never removes existing genres, only adds newly-derived
// ones that aren't already present. Only touches books with an Open Library
// work ID (goodreadsId starting "OL") — Google-Books-sourced books use a
// different ID scheme and aren't covered here.
//
// Usage: node scripts/backfill-ya-genres.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { filterOpenLibraryGenres } = require('../src/services/mediaLookup');
const { normalizeBookGenres } = require('../src/lib/mediaHelpers');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchSubjects(workId) {
  const res = await fetch(`https://openlibrary.org/works/${workId}.json`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.subjects || [];
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', goodreadsId: { startsWith: 'OL' } },
    select: { id: true, title: true, genres: true, goodreadsId: true },
  });
  console.log(`Checking ${books.length} Open-Library-sourced book(s)${dryRun ? ' (dry run)' : ''}...`);

  let changed = 0, failed = 0;
  for (const book of books) {
    let subjects;
    try {
      subjects = await fetchSubjects(book.goodreadsId);
    } catch {
      subjects = null;
    }
    if (subjects === null) {
      failed++;
      await sleep(120);
      continue;
    }

    const rawGenres = filterOpenLibraryGenres(subjects);
    const normalized = normalizeBookGenres(rawGenres);
    const toAdd = normalized.filter(g => !book.genres.includes(g));

    if (toAdd.length) {
      changed++;
      console.log(`"${book.title}": +${toAdd.join(', +')}`);
      if (!dryRun) {
        await prisma.mediaItem.update({
          where: { id: book.id },
          data: { genres: [...new Set([...book.genres, ...toAdd])] },
        });
      }
    }
    await sleep(120);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Changed: ${changed} / ${books.length}`);
  console.log(`Failed to fetch: ${failed}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
