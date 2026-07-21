// Reusable post-import check: external book APIs format the same author's
// name inconsistently across editions ("Brink, JF" / "Jf Brink" /
// "J.F. Brink" all turned up as three separate Person records for one real
// author, confirmed live during the bibliography-expansion project). This
// finds Person records whose name is identical once you strip punctuation,
// case, and comma-reordering ("Last, First" -> "First Last") and merges
// them into whichever variant has the most existing credits.
//
// Deliberately conservative: only merges on pure formatting differences.
// Doesn't attempt to detect a pen name that reads as a genuinely different
// string (e.g. "TheFirstDefier" for "J.F. Brink") — that needs a human
// judgment call (checked for: does this look like two people credited
// together on every single one of the same books? worth a manual look).
//
// Usage: node scripts/consolidate-person-duplicates.js [--dry-run] [name-filter]
// name-filter (optional): only consider Persons whose name contains this
// substring, to scope the check to authors touched by a recent batch
// rather than scanning the whole Person table every time.
require('dotenv').config();
const prisma = require('../src/lib/prisma');

function normalizePersonName(name) {
  let n = (name || '').trim();
  const commaMatch = n.match(/^([^,]+),\s*(.+)$/);
  if (commaMatch) n = `${commaMatch[2]} ${commaMatch[1]}`;
  return n.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filter = args.find(a => !a.startsWith('--'));

  const people = await prisma.person.findMany({
    where: filter ? { name: { contains: filter, mode: 'insensitive' } } : undefined,
    include: { _count: { select: { authored: true, appeared: true, directed: true } } },
  });

  const byNorm = new Map();
  for (const p of people) {
    const key = normalizePersonName(p.name);
    if (!byNorm.has(key)) byNorm.set(key, []);
    byNorm.get(key).push(p);
  }

  let mergedGroups = 0;
  for (const [key, group] of byNorm) {
    if (group.length < 2) continue;
    mergedGroups++;
    // Keep whichever variant has the most total credits; merge the rest into it.
    group.sort((a, b) => {
      const ac = a._count.authored + a._count.appeared + a._count.directed;
      const bc = b._count.authored + b._count.appeared + b._count.directed;
      return bc - ac;
    });
    const [canonical, ...dupes] = group;
    console.log(`\n"${key}" — keeping "${canonical.name}" (${canonical._count.authored + canonical._count.appeared + canonical._count.directed} credits), merging:`);
    for (const dup of dupes) {
      console.log(`  - "${dup.name}" (${dup._count.authored + dup._count.appeared + dup._count.directed} credits)`);
      if (!dryRun) {
        const books = await prisma.mediaItem.findMany({
          where: { OR: [{ authors: { some: { id: dup.id } } }, { cast: { some: { id: dup.id } } }, { directors: { some: { id: dup.id } } }] },
          select: { id: true, authors: { select: { id: true } }, cast: { select: { id: true } }, directors: { select: { id: true } } },
        });
        for (const b of books) {
          const data = {};
          if (b.authors.some(a => a.id === dup.id)) data.authors = { connect: { id: canonical.id }, disconnect: { id: dup.id } };
          if (b.cast.some(a => a.id === dup.id)) data.cast = { connect: { id: canonical.id }, disconnect: { id: dup.id } };
          if (b.directors.some(a => a.id === dup.id)) data.directors = { connect: { id: canonical.id }, disconnect: { id: dup.id } };
          await prisma.mediaItem.update({ where: { id: b.id }, data });
        }
        await prisma.person.delete({ where: { id: dup.id } });
      }
    }
  }
  console.log(`\n${dryRun ? 'Would merge' : 'Merged'} ${mergedGroups} duplicate group(s).`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
