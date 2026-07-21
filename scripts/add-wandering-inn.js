// One-time manual backfill of The Wandering Inn's 21 published ebooks.
// Not run through bulk-import.js's normal TMDB/Google Books/Open Library
// lookup path — confirmed live that automated matching is unreliable for
// this specific series (Google Books returned a same-author, wrong-title
// false positive for "The Last Light" -> "The Last Tide", a genuine
// same-universe spin-off book, and separately matched "The General of
// Izril" back to the generic "The Wandering Inn" record instead of
// reporting no match). Titles/order verified directly against
// https://wiki.wanderinginn.com/Ebook rather than trusted from memory.
// No cover image or description available without a working external
// lookup — left null rather than guessed.
//
// Usage: node scripts/add-wandering-inn.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { slugify, uniqueSlug, connectPersons, findDuplicate } = require('../src/lib/mediaHelpers');

const GENRES = ['Fiction', 'Fantasy', 'Progression Fantasy'];
const AUTHOR = 'pirateaba';

const BOOKS = [
  'The Wandering Inn', 'No Killing Goblins', 'Fae and Fare', 'Immortal Games',
  'Flowers of Esthelm', 'Winter Solstice', 'The Last Light', 'The General of Izril',
  'The Rains of Liscor', 'Blood of Liscor', 'Tears of Liscor', 'The Wind Runner',
  'The Titan of Baleros', 'The Witch of Webs', 'The Empress of Beasts', "Hell's Wardens",
  'Garden of Sanctuary', 'King of Duels', 'Lady of Fire', "Archmage's Ire", 'Couriers Outbound',
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  let added = 0, skipped = 0;

  for (let i = 0; i < BOOKS.length; i++) {
    const title = BOOKS[i];
    const seriesNumber = i + 1;

    const duplicate = await findDuplicate({ title, mediaType: 'BOOK', authors: [AUTHOR] });
    if (duplicate) {
      console.log(`⚠ "${title}" — already in database (${duplicate.slug}), skipping`);
      skipped++;
      continue;
    }

    console.log(`+ "${title}" (BOOK) — The Wandering Inn #${seriesNumber} — would be added`);
    added++;

    if (!dryRun) {
      const slug = await uniqueSlug(slugify(title, null));
      await prisma.mediaItem.create({
        data: {
          mediaType: 'BOOK',
          title,
          slug,
          seriesName: 'The Wandering Inn',
          seriesNumber,
          genres: GENRES,
          verified: false,
          authors: await connectPersons([AUTHOR]),
        },
      });
    }
  }

  console.log(`\nDone. Added ${added}, skipped ${skipped}.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
