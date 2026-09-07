// scripts/backfill-message-emails.js
//
// One-off: sends the new-message notification email for messages that were
// sent BEFORE that email existed (the feature shipped 2026-09-01, see
// sendNewMessageEmail in src/services/email.js). Nothing in the app does this
// on its own — POST /api/messages only mails at the moment a message is sent.
//
//   node scripts/backfill-message-emails.js              # dry run (default)
//   node scripts/backfill-message-emails.js --send       # actually send
//
// Dry run first, always — same convention as bulk-import.js. This one mails
// real people and email can't be unsent.
//
// Deliberate choices:
//   * ONE email per conversation, not per message. A recipient with several
//     unread messages gets a single nudge; the preview quotes the most recent
//     and the email says how many are waiting.
//   * Only recipients with emailOnMessage:true, same gate as the live path.
//   * Only messages still unread — someone who already read it in the app
//     doesn't need an email about it.
//   * --send refuses to run without RESEND_API_KEY rather than falling through
//     to sendEmail's log-only dev mode, which returns success and sends
//     nothing. Reporting a simulated send as a real one is the one failure
//     mode that matters here.
//
// SENDER_USERNAME/DAYS are the scope this was written for; both are
// overridable so the script isn't single-use.

const prisma = require('../src/lib/prisma');
const { sendNewMessageEmail } = require('../src/services/email');

const SEND = process.argv.includes('--send');
const SENDER_USERNAME = process.env.SENDER_USERNAME || 'rufiohhhhh';
const DAYS = parseInt(process.env.DAYS || '30', 10);

// Anything sent from this moment on already got its email from
// POST /api/messages, so backfilling it sends a duplicate. This is the deploy
// of commit 9705199 ("Add opt-out email notifications for new messages").
//
// Learned the hard way: the first run of this script had no such cutoff and
// mailed two people twice — a message sent 11 minutes after the deploy, and
// another sent between the dry run and the real run. Nothing in the DB records
// that an email went out, so the timestamp is the only thing that can tell
// these apart.
const FEATURE_LIVE_AT = new Date('2026-09-01T17:06:15Z');

async function main() {
  if (SEND && !process.env.RESEND_API_KEY) {
    console.error('✗ --send needs RESEND_API_KEY (Railway → Variables → RESEND_API_KEY).');
    console.error('  Without it src/services/email.js logs instead of sending and reports');
    console.error('  success, so this would claim to have mailed people and not have.');
    process.exit(1);
  }

  const sender = await prisma.user.findUnique({
    where: { username: SENDER_USERNAME },
    select: { id: true, username: true, displayName: true },
  });
  if (!sender) throw new Error(`No such user: ${SENDER_USERNAME}`);

  const since = new Date(Date.now() - DAYS * 86400000);
  const messages = await prisma.message.findMany({
    where: {
      senderId: sender.id,
      createdAt: { gte: since, lt: FEATURE_LIVE_AT },
      read: false,
    },
    include: {
      recipient: {
        select: { id: true, username: true, displayName: true, email: true, emailOnMessage: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Group by recipient; findMany came back newest-first, so the first message
  // seen for each recipient is the one to quote.
  const byRecipient = new Map();
  for (const m of messages) {
    const entry = byRecipient.get(m.recipient.id);
    if (entry) { entry.count++; continue; }
    byRecipient.set(m.recipient.id, { recipient: m.recipient, latest: m, count: 1 });
  }

  const plan = [...byRecipient.values()];
  const sending = plan.filter(p => p.recipient.emailOnMessage);
  const skipped = plan.filter(p => !p.recipient.emailOnMessage);

  console.log(`Sender:   @${sender.username} (${sender.displayName})`);
  console.log(`Window:   last ${DAYS} days, up to ${FEATURE_LIVE_AT.toISOString()} (feature go-live)`);
  console.log(`          ${messages.length} unread message(s), ${plan.length} conversation(s)`);
  console.log(`Mode:     ${SEND ? 'SEND (real emails)' : 'DRY RUN (nothing sent)'}\n`);

  for (const p of sending) {
    const age = ((Date.now() - p.latest.createdAt) / 86400000).toFixed(1);
    console.log(`  → ${p.recipient.email}  (@${p.recipient.username})`);
    console.log(`    ${p.count} unread, latest ${age}d ago: "${p.latest.body.slice(0, 60)}${p.latest.body.length > 60 ? '…' : ''}"`);
  }
  for (const p of skipped) {
    console.log(`  ⊘ @${p.recipient.username} — emailOnMessage is off, skipping`);
  }
  if (!sending.length) { console.log('  (nothing to send)'); return; }

  if (!SEND) {
    console.log(`\nDry run only. Re-run with --send to mail these ${sending.length} recipient(s).`);
    return;
  }

  console.log('');
  let sent = 0, failed = 0;
  for (const p of sending) {
    try {
      const result = await sendNewMessageEmail({
        to: p.recipient.email,
        displayName: p.recipient.displayName,
        fromDisplayName: sender.displayName,
        fromUsername: sender.username,
        preview: p.latest.body.slice(0, 80),
      });
      // Belt and braces — the guard at the top should make this unreachable.
      if (result?.simulated) throw new Error('email service ran in log-only mode');
      console.log(`  ✓ sent to ${p.recipient.email}`);
      sent++;
    } catch (err) {
      console.error(`  ✗ FAILED ${p.recipient.email}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nSent ${sent}, failed ${failed}.`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
