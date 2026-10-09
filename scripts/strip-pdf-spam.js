/**
 * Remove pirate-PDF link spam from book descriptions.
 *
 *   node scripts/strip-pdf-spam.js            # dry run, prints every change
 *   node scripts/strip-pdf-spam.js --apply    # writes
 *
 * Scoped deliberately to one host. Book descriptions also carry Wikipedia
 * and publisher links that are SOURCE ATTRIBUTION, not spam — Wikipedia text
 * is CC BY-SA and dropping the credit would be a licensing problem, so those
 * stay. Open Library's "Also contained in:" blocks stay too: clutter, not
 * spam, and a separate decision.
 *
 * Writes with raw SQL so MediaItem.updatedAt keeps its real value. A mass
 * UPDATE through Prisma restamps @updatedAt on every row it touches, which
 * is how 1,065 reviews once came to read as "just edited".
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const HOST = 'chesserresources';
const APPLY = process.argv.includes('--apply');

const LINK_TO_HOST = new RegExp('\\[[^\\]]*\\]\\(https?://[^)]*' + HOST + '[^)]*\\)', 'gi');
// A "<Title> pdf" shout left behind once its link is gone. Anchored to the
// end, because that is where every one of these sits — an emphasised "pdf"
// in the middle of real copy would be the author's words, not the spammer's.
const TRAILING_PDF_SHOUT = /\*{1,3}[^*\n]{0,90}?\bpdf\b[^*\n]{0,25}?\*{1,3}\s*$/i;

function clean(text, removed) {
  let s = text;
  s = s.replace(LINK_TO_HOST, (m) => { if (removed) removed.push(['link', m]); return ''; });
  s = s.replace(TRAILING_PDF_SHOUT, (m) => { if (removed) removed.push(['shout', m]); return ''; });
  // "(From [link])" loses its link and leaves "(From )" or a dangling "(From".
  s = s.replace(/\(\s*From\s*\)/gi, '');
  s = s.replace(/\(\s*From\s*(?=\r?\n|$)/gi, '');
  // Tidy the wreckage: emptied emphasis, empty brackets, trailing rules.
  s = s.replace(/\*{2,3}\s*\*{2,3}/g, '');
  s = s.replace(/\[\s*\]/g, '');
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/(\r?\n){3,}/g, '\n\n');
  s = s.replace(/[\s\\*–—-]+$/, '');
  return s.trim();
}

(async () => {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id, title, slug, description FROM "MediaItem" WHERE description ILIKE $1 ORDER BY title',
    '%' + HOST + '%');
  console.log(`${rows.length} description(s) mention ${HOST}\n`);

  let changed = 0;
  const stillDirty = [];
  for (const r of rows) {
    const removed = [];
    const out = clean(r.description, removed);
    const dirty = out.toLowerCase().includes(HOST);
    if (dirty) stillDirty.push(r.title);
    if (out === r.description) { console.log(`unchanged — ${r.title}\n`); continue; }
    changed++;
    // Every span the two content rules took out, verbatim. The later rules
    // only touch whitespace and emptied punctuation, so the difference
    // between these and the length delta is tidying, nothing readable.
    const spans = removed.reduce((a, [, m]) => a + m.length, 0);
    console.log(`${r.title}  (${r.slug})`);
    for (const [kind, m] of removed) console.log(`   - ${kind}: ${JSON.stringify(m)}`);
    console.log(`   ${r.description.length} -> ${out.length} chars`
      + ` (${spans} removed by rule, ${r.description.length - out.length - spans} by tidying)`);
    if (dirty) console.log('   !! still mentions the host — NOT clean');
    console.log();
    if (APPLY && !dirty) {
      await prisma.$executeRawUnsafe('UPDATE "MediaItem" SET description = $1 WHERE id = $2', out, r.id);
    }
  }
  if (stillDirty.length) console.log(`Left alone because a link survived: ${stillDirty.join(', ')}`);
  console.log(APPLY
    ? `\nAPPLIED to ${changed - stillDirty.length} row(s).`
    : `\nDRY RUN — ${changed} row(s) would change. Re-run with --apply.`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
