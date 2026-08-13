// scripts/backfill-verified-users.js
//
// One-time backfill: marks every existing local (email/password) account as
// isVerified so nobody gets locked out when login starts requiring email
// confirmation. Only new registrations and future email changes go through
// the confirmation flow — this grandfathers in accounts that already exist.
//
// Run once, after the migration adding EmailVerificationToken has been
// applied and before (or right as) the verification-gated code deploys:
//   node scripts/backfill-verified-users.js
//   node scripts/backfill-verified-users.js --dry-run
const prisma = require('../src/lib/prisma');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const candidates = await prisma.user.findMany({
    where: { passwordHash: { not: null }, isVerified: false },
    select: { id: true, email: true, username: true },
  });

  console.log(`${candidates.length} local account(s) to grandfather in as verified.`);
  candidates.forEach(u => console.log(`  - ${u.username} <${u.email}>`));

  if (dryRun) {
    console.log('\nDry run — no changes made.');
    return;
  }

  const result = await prisma.user.updateMany({
    where: { passwordHash: { not: null }, isVerified: false },
    data: { isVerified: true },
  });
  console.log(`\nUpdated ${result.count} account(s).`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
