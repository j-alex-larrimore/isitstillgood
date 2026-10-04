// Read-only quality report over BOOK rows: title, author, year, description
// and cover. Writes nothing — it tells you what is wrong so you can decide what
// is worth fixing.
//
//   node scripts/audit-book-quality.js
//   node scripts/audit-book-quality.js --examples=12
//   node scripts/audit-book-quality.js --only=title,description
//
// Deliberately offline. Every check here runs off what is already in the
// database, so the whole catalogue is auditable in seconds for free. Verifying
// a field against an external source is a different and much more expensive
// job — Google Books is ~1,000 lookups a day against 7,500 books — and is not
// worth starting before knowing which fields are actually suspect.
//
// Existing cover scripts cover ground this one does not, and vice versa:
//   audit-cover-mismatches.js  — is a Google Books cover the wrong BOOK
//   audit-book-covers.js       — is an Open Library cover the wrong LANGUAGE
//   prefer-english-covers.js   — swap to an English edition's cover
// This looks for structural damage instead: covers shared between books,
// descriptions that are really HTML or a table of contents, authors that are
// publishers, titles carrying their own author's name.
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const args = process.argv.slice(2);
const EXAMPLES = parseInt((args.find(a => a.startsWith('--examples=')) || '').split('=')[1], 10) || 6;
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1]?.split(',') || null;

const NONLATIN = /[Ѐ-ӿͰ-Ͽ֐-׿؀-ۿऀ-ॿ฀-๿ᄀ-ᇿ぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
const THIS_YEAR = new Date().getFullYear();

// Words that mark an "author" as an organisation rather than a person. Kept
// narrow on purpose: "Press" catches Oxford University Press without catching
// a person surnamed Pressley, because it is matched as a whole word.
const ORG_WORDS = /\b(inc|ltd|llc|press|publishing|publishers|publications|books|media|editorial|verlag|company|corporation|society|association|institute|university|college|committee|department|ministry|bureau|agency|foundation|trust|group|studios?|productions?)\b/i;

const findings = [];
const add = (field, code, label, rows) => findings.push({ field, code, label, rows });

(async () => {
  const books = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK' },
    select: {
      id: true, title: true, slug: true, releaseYear: true, description: true,
      imageUrl: true, isbns: true, genres: true, verified: true,
      authors: { select: { name: true } },
    },
  });
  const label = b => `${b.title.slice(0, 44)}${b.releaseYear ? ` (${b.releaseYear})` : ''}`;
  const want = f => !ONLY || ONLY.includes(f);

  // ── TITLE ───────────────────────────────────────────────────────────────
  if (want('title')) {
    add('title', 'blank', 'empty or whitespace-only', books.filter(b => !b.title?.trim()));
    add('title', 'edge-space', 'leading or trailing whitespace', books.filter(b => b.title !== b.title?.trim()));
    // 5+ chars so acronym titles like "NATO" aren't flagged.
    add('title', 'allcaps', 'ALL CAPS', books.filter(b => b.title?.length > 4 && b.title === b.title.toUpperCase() && /[A-Z]{3}/.test(b.title)));
    add('title', 'lowercase', 'starts lowercase', books.filter(b => /^[a-z]/.test(b.title || '')));
    // "Anna Karenina by Leo Tolstoy" — the author leaked into the title field.
    add('title', 'by-author', 'contains "by <author>"', books.filter(b => /\sby\s+[A-Z]/.test(b.title || '') && b.authors.some(a => (b.title || '').toLowerCase().includes(a.name.toLowerCase().split(' ').pop()))));
    add('title', 'dup-word', 'immediately repeated word', books.filter(b => /\b(\w{3,})\s+\1\b/i.test(b.title || '')));
    add('title', 'nonlatin', 'non-Latin script', books.filter(b => NONLATIN.test(b.title || '')));
    add('title', 'very-long', 'over 120 characters', books.filter(b => (b.title || '').length > 120));
    add('title', 'has-isbn', 'contains a 10+ digit run', books.filter(b => /\d{10,}/.test(b.title || '')));
  }

  // ── AUTHOR ──────────────────────────────────────────────────────────────
  if (want('author')) {
    add('author', 'none', 'no author at all', books.filter(b => !b.authors.length));
    add('author', 'nonlatin', 'non-Latin script', books.filter(b => b.authors.some(a => NONLATIN.test(a.name))));
    add('author', 'flipped', 'stored "Last, First"', books.filter(b => b.authors.some(a => /^[^,]+,\s*[^,]+$/.test(a.name))));
    add('author', 'et-al', 'contains "and others" / "et al"', books.filter(b => b.authors.some(a => /\b(and others|et al)\b/i.test(a.name))));
    add('author', 'org', 'looks like an organisation', books.filter(b => b.authors.some(a => ORG_WORDS.test(a.name))));
    add('author', 'is-title', 'author name equals the title', books.filter(b => b.authors.some(a => a.name.toLowerCase() === (b.title || '').toLowerCase())));
    add('author', 'initials', 'initials only', books.filter(b => b.authors.some(a => /^([A-Z]\.?\s*){1,3}$/.test(a.name.trim()))));
    add('author', 'crowd', 'more than 5 authors', books.filter(b => b.authors.length > 5));
  }

  // ── YEAR ────────────────────────────────────────────────────────────────
  if (want('year')) {
    add('year', 'none', 'no year', books.filter(b => b.releaseYear == null));
    add('year', 'ancient', 'before 1400', books.filter(b => b.releaseYear != null && b.releaseYear < 1400));
    add('year', 'future', `after ${THIS_YEAR + 1}`, books.filter(b => b.releaseYear != null && b.releaseYear > THIS_YEAR + 1));
  }

  // ── DESCRIPTION ─────────────────────────────────────────────────────────
  if (want('description')) {
    const has = books.filter(b => b.description?.trim());
    add('description', 'none', 'missing', books.filter(b => !b.description?.trim()));
    add('description', 'stub', 'under 80 characters', has.filter(b => b.description.trim().length < 80));
    add('description', 'html', 'contains HTML tags', has.filter(b => /<\/?(p|br|a|i|b|em|strong|div|span)\b/i.test(b.description)));
    add('description', 'entities', 'contains HTML entities', has.filter(b => /&(amp|quot|#\d+|nbsp|lt|gt);/i.test(b.description)));
    add('description', 'nonlatin', 'non-Latin script', has.filter(b => NONLATIN.test(b.description)));
    add('description', 'promo', 'promotional or marketplace text', has.filter(b => /\b(amazon|kindle edition|click here|buy now|best ?seller list|www\.|https?:\/\/)/i.test(b.description)));
    add('description', 'toc', 'looks like a table of contents', has.filter(b => /table of contents|^contents\b/i.test(b.description)));

    // The same blurb on several books means a lookup attached one book's text
    // to others — far more damaging than a missing description, because it
    // reads as real.
    const byDesc = new Map();
    for (const b of has) {
      const k = b.description.trim().slice(0, 200);
      if (!byDesc.has(k)) byDesc.set(k, []);
      byDesc.get(k).push(b);
    }
    add('description', 'shared', 'identical text on 2+ books',
      [...byDesc.values()].filter(g => g.length > 1).flat());
  }

  // ── COVER ───────────────────────────────────────────────────────────────
  if (want('cover')) {
    add('cover', 'none', 'no cover', books.filter(b => !b.imageUrl));
    const withCover = books.filter(b => b.imageUrl);
    const byUrl = new Map();
    for (const b of withCover) {
      if (!byUrl.has(b.imageUrl)) byUrl.set(b.imageUrl, []);
      byUrl.get(b.imageUrl).push(b);
    }
    // Two books cannot legitimately share cover art. Either one is wrong or
    // they are duplicate rows.
    add('cover', 'shared', 'same cover URL on 2+ books',
      [...byUrl.values()].filter(g => g.length > 1).flat());
    add('cover', 'data-uri', 'base64 data: URI instead of a URL', withCover.filter(b => /^data:/i.test(b.imageUrl)));
  }

  // ── ISBN / discoverability ──────────────────────────────────────────────
  if (want('isbn')) {
    add('isbn', 'none', 'no ISBN at all (cannot match an import)', books.filter(b => !b.isbns.length));
    add('isbn', 'nogenre', 'no genres', books.filter(b => !b.genres.length));
  }

  // ── report ──────────────────────────────────────────────────────────────
  console.log(`${books.length} books audited\n`);
  let field = null;
  for (const f of findings) {
    if (!f.rows.length) continue;
    if (f.field !== field) { field = f.field; console.log(`── ${field.toUpperCase()}`); }
    const pct = (f.rows.length / books.length * 100).toFixed(1);
    console.log(`   ${String(f.rows.length).padStart(5)}  ${pct.padStart(5)}%  ${f.label}`);
    for (const b of f.rows.slice(0, EXAMPLES)) {
      const extra = f.field === 'author' ? `  [${b.authors.map(a => a.name).join(', ').slice(0, 44)}]`
                  : f.field === 'description' ? `  "${(b.description || '').replace(/\s+/g, ' ').slice(0, 54)}"`
                  : '';
      console.log(`            · ${label(b)}${extra}`);
    }
  }

  const clean = books.filter(b =>
    b.title?.trim() && b.authors.length && b.releaseYear != null &&
    b.description?.trim()?.length >= 80 && b.imageUrl && b.isbns.length);
  console.log(`\ncomplete rows (title, author, year, 80+ char description, cover, ISBN): ${clean.length}/${books.length} (${(clean.length / books.length * 100).toFixed(1)}%)`);

  await prisma.$disconnect();
})().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
