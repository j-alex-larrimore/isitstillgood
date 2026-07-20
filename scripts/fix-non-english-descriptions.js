// Replaces non-English book descriptions (e.g. Madame Bovary's description
// stored in French) with an English one, by re-querying Google Books with
// langRestrict=en. Open Library descriptions aren't language-tagged, so a
// French/German/Spanish/Italian edition's summary sometimes got picked up
// verbatim at import time.
//
// Two-stage detection: a broad heuristic flags candidates (foreign stopwords
// or accented characters above a threshold), then each candidate is
// hand-verified against its full description before being added to
// CONFIRMED_NON_ENGLISH below — several initial heuristic hits turned out to
// be false positives (an English description that just happens to mention a
// French character name or title, e.g. "Thérèse Raquin", "Au bonheur des
// dames", "The Black Cat"). Only the hand-confirmed list is touched.
//
// For each confirmed book: search Google Books with langRestrict=en using
// its title + author, and only replace the stored description if the
// result (a) exists and (b) does not itself trip the foreign-text
// heuristic. Otherwise the row is left untouched and logged for manual
// follow-up — never nulled out, since a wrong-language description is still
// better than no description at all when no English replacement is found.
//
// Usage: node scripts/fix-non-english-descriptions.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { searchGoogleBooks } = require('../src/services/mediaLookup');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CONFIRMED_NON_ENGLISH = [
  'Oedipe', 'Thesmophoriazusae', 'El Zorro', 'Violeta', 'Le docteur Pascal',
  'The Willoughbys', 'Chasing Redbird', 'Matilda', 'Sanctuary',
  'Les confessions', 'Une page d\'amour', 'La terre', 'Mathilda',
  'Madame Bovary', 'La fortune des Rougon', 'Le ventre de Paris',
];

const FOREIGN_STOP = /\b(le|la|les|des|une|un|et|dans|avec|pour|qui|que|est|était|être|sur|ces|cette|son|sa|ses|il|elle|ils|elles|du|au|aux|der|die|das|und|ist|nicht|mit|von|für|el|los|las|una|unos|unas|es|del|por|di|che|non|questo|questa)\b/gi;
const ACCENTED = /[éèêëàâîïôûùüçœñ]/gi;

function looksForeign(text) {
  const stopMatches = (text.match(FOREIGN_STOP) || []).length;
  const accentCount = (text.match(ACCENTED) || []).length;
  return stopMatches >= 4 || accentCount >= 4;
}

// Some Google Books results for public-domain titles come from generic
// print-on-demand reprint listings — mangled character encoding (the
// replacement character, or "√" mojibake from double-encoded accents like
// "√âmile Zola") and boilerplate "rare manuscript" marketing copy instead of
// an actual description. Reject those too, even though they pass the
// English-language check.
function looksLikeJunk(text) {
  if (text.includes('�') || text.includes('√')) return true;
  if (/rare manuscript.*great librar/i.test(text)) return true;
  return false;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', title: { in: CONFIRMED_NON_ENGLISH } },
    select: { id: true, title: true, description: true, releaseYear: true, authors: { select: { name: true } } },
  });
  console.log(`Checking ${books.length} confirmed non-English book(s)${dryRun ? ' (dry run)' : ''}...`);

  let fixed = 0, noGoodMatch = 0;
  for (const book of books) {
    const author = book.authors[0]?.name || null;
    let results = [];
    try {
      results = await searchGoogleBooks(book.title, author, book.releaseYear, undefined, 'en');
    } catch (e) {
      console.log(`"${book.title}": Google Books lookup failed (${e.message})`);
    }

    const candidate = results.find(r => r.description && r.description.length > 40 && !looksForeign(r.description) && !looksLikeJunk(r.description));
    if (candidate) {
      fixed++;
      console.log(`\n"${book.title}":`);
      console.log(`  OLD: ${book.description.slice(0, 120)}...`);
      console.log(`  NEW: ${candidate.description.slice(0, 120)}...`);
      if (!dryRun) {
        await prisma.mediaItem.update({ where: { id: book.id }, data: { description: candidate.description } });
      }
    } else {
      noGoodMatch++;
      console.log(`"${book.title}": no English replacement found — left unchanged, needs manual review`);
    }
    await sleep(300);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Fixed: ${fixed} / ${books.length}`);
  console.log(`No good match (unchanged): ${noGoodMatch}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
