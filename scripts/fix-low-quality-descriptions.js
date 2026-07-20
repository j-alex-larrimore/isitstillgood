// Replaces low-quality book descriptions — ALL CAPS marketing copy pasted
// verbatim (e.g. "The Job"), and very short fragments/junk (bibliographic
// notes like "2 volumes ; 22 cm", stray reader comments like "potato is
// cool" or "it is awesome", or just the title restated) — with a real
// description re-fetched from Google Books (langRestrict=en). Same
// conservative approach as fix-non-english-descriptions.js: only replaces
// when a candidate passes quality checks.
//
// When no good replacement is found, most rows are simply left untouched —
// but if the existing description mechanically matches a confirmed-junk
// pattern (see isDefinitelyJunk below: reprint-publisher boilerplate,
// alternate-title notes, casual reader comments, bibliographic notes, bare
// title lists, non-Latin-script dumps, or near-empty text), it's cleared to
// null instead of leaving unprofessional text in place. A genuinely terse
// but real description (e.g. The Silver Chair's "Jill and Eustace must
// rescue the Prince from the evil Witch.") is left alone — this only clears
// mechanically-recognizable junk, never guesses based on length alone.
//
// Usage: node scripts/fix-low-quality-descriptions.js [--dry-run]
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { searchGoogleBooks } = require('../src/services/mediaLookup');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHORT_THRESHOLD = 70;

// Same foreign-language heuristic as fix-non-english-descriptions.js —
// Google Books candidates for these titles (mostly French/Italian/Spanish
// classics) frequently come back in the original language even with
// langRestrict=en, since that param restricts by the edition's catalog
// language tag, not by verifying the actual description text.
const FOREIGN_STOP = /\b(le|la|les|des|une|un|et|dans|avec|pour|qui|que|est|était|être|sur|ces|cette|son|sa|ses|il|elle|ils|elles|du|au|aux|der|die|das|und|ist|nicht|mit|von|für|el|los|las|una|unos|unas|es|del|por|di|che|non|questo|questa)\b/gi;
const ACCENTED = /[éèêëàâîïôûùüçœñ]/gi;
function looksForeign(text) {
  const stopMatches = (text.match(FOREIGN_STOP) || []).length;
  const accentCount = (text.match(ACCENTED) || []).length;
  return stopMatches >= 4 || accentCount >= 4;
}

function isAllCaps(text) {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 30) return false;
  const upper = letters.replace(/[^A-Z]/g, '');
  return upper.length / letters.length > 0.8;
}

// Bibliographic physical-description notes ("2 volumes ; 22 cm", "xiii, 587
// p. ; 18 cm") leak in from Open Library catalog records — not descriptions
// at all.
const BIBLIOGRAPHIC_NOTE = /\b\d+\s*(p\.|pages|vol(ume)?s?\.?)\b.*\bcm\b|^\s*[ivxlc]+,?\s*\d+\s*p\./i;

function isLowQuality(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < SHORT_THRESHOLD) return true;
  if (isAllCaps(trimmed)) return true;
  if (BIBLIOGRAPHIC_NOTE.test(trimmed)) return true;
  return false;
}

// Google Books sometimes returns a bare, delimiter-joined list of titles
// (e.g. multi-volume set listings: "Henry Huggins))Henry and Ribsy))...")
// instead of an actual description.
const TITLE_LIST_DUMP = /\)\)/;

// Patterns confirmed, by direct user review, to be unprofessional junk
// rather than genuine (if terse) descriptions — a real one-sentence
// description like The Silver Chair's "Jill and Eustace must rescue the
// Prince from the evil Witch." should NOT be cleared just for being short.
// This only covers mechanically-recognizable junk; anything else that fails
// to find a replacement is left alone rather than guessed at.
const REPRINT_BOILERPLATE = /reprint of the original edition|includes bibliography|chronology.*explanatory notes|selected by scholars.*culturally important|knowledge base of civilization|rare manuscript.*great librar/i;
const ALTERNATE_TITLE_NOTE = /^AKA\b/i;
const CASUAL_READER_VOICE = /^(i |i'|it is |it's |very |good book|great book|nice book|love (it|this)|really (enjoy|like)|awesome\b|funny\b)/i;

function isNonLatinScript(text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 5) return false;
  const nonLatin = letters.replace(/[a-zA-ZÀ-ÿ]/g, '');
  return nonLatin.length / letters.length > 0.5;
}

function isDefinitelyJunk(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (REPRINT_BOILERPLATE.test(trimmed)) return true;
  if (ALTERNATE_TITLE_NOTE.test(trimmed)) return true;
  if (CASUAL_READER_VOICE.test(trimmed)) return true;
  if (isAllCaps(trimmed)) return true;
  if (BIBLIOGRAPHIC_NOTE.test(trimmed)) return true;
  if (TITLE_LIST_DUMP.test(trimmed)) return true;
  if (isNonLatinScript(trimmed)) return true;
  if (trimmed.split(/\s+/).length <= 4) return true; // "Funny", "A novel.", etc.
  return false;
}

function isGoodCandidate(text, currentLength) {
  if (!text || text.length < SHORT_THRESHOLD) return false;
  if (text.length <= currentLength) return false; // must be a real improvement
  if (isAllCaps(text)) return false;
  if (BIBLIOGRAPHIC_NOTE.test(text)) return false;
  if (looksForeign(text)) return false;
  if (TITLE_LIST_DUMP.test(text)) return false;
  // '�' (replacement char) and 'â€' (mis-decoded curly quote/dash — classic
  // UTF-8-read-as-Latin-1 mojibake) and '√' both indicate encoding-mangled
  // source text, not just the rare-manuscript boilerplate phrase.
  if (text.includes('�') || text.includes('√') || text.includes('â€')) return false;
  if (/rare manuscript.*great librar/i.test(text)) return false;
  // Another generic public-domain-reprint-publisher template (seen verbatim
  // across unrelated titles) — real English, but zero actual synopsis.
  if (/selected by scholars.*culturally important|knowledge base of civilization/i.test(text)) return false;
  return true;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', description: { not: null } },
    select: { id: true, title: true, description: true, releaseYear: true, authors: { select: { name: true } } },
  });
  const flagged = books.filter(b => isLowQuality(b.description));
  console.log(`Found ${flagged.length} low-quality book description(s)${dryRun ? ' (dry run)' : ''}...`);

  let fixed = 0, cleared = 0, noGoodMatch = 0;
  for (const book of flagged) {
    const author = book.authors[0]?.name || null;
    let results = [];
    try {
      results = await searchGoogleBooks(book.title, author, book.releaseYear, undefined, 'en');
    } catch (e) {
      console.log(`"${book.title}": Google Books lookup failed (${e.message})`);
    }

    const candidate = results.find(r => isGoodCandidate(r.description, book.description.trim().length));
    if (candidate) {
      fixed++;
      console.log(`\n"${book.title}":`);
      console.log(`  OLD: ${book.description.slice(0, 120)}`);
      console.log(`  NEW: ${candidate.description.slice(0, 120)}...`);
      if (!dryRun) {
        await prisma.mediaItem.update({ where: { id: book.id }, data: { description: candidate.description } });
      }
    } else if (isDefinitelyJunk(book.description)) {
      cleared++;
      console.log(`"${book.title}": no replacement found, clearing junk description (was: ${JSON.stringify(book.description.slice(0, 60))})`);
      if (!dryRun) {
        await prisma.mediaItem.update({ where: { id: book.id }, data: { description: null } });
      }
    } else {
      noGoodMatch++;
      console.log(`"${book.title}": no better description found — left unchanged (current: ${JSON.stringify(book.description.slice(0, 60))})`);
    }
    await sleep(300);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Fixed: ${fixed} / ${flagged.length}`);
  console.log(`Cleared (junk, no replacement found): ${cleared}`);
  console.log(`No good match (left unchanged): ${noGoodMatch}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
