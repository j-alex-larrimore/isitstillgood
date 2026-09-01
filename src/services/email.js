// src/services/email.js
//
// Handles all outgoing email for IsItStillGood.com using Resend.
// Resend docs: https://resend.com/docs
//
// To activate: add RESEND_API_KEY to your Railway environment variables.
// Get your key at: https://resend.com/api-keys
// All emails send from hello@isitstillgood.com

// ─── Configuration ───────────────────────────────────────────────────────────
const FROM_ADDRESS = 'noreply@isitstillgood.com';
const SITE_URL = process.env.CLIENT_URL || 'https://isitstillgood.com';
// Verification links must hit the API directly (GET /api/auth/verify-email
// does the DB work itself, then redirects to SITE_URL) — not an env var
// Railway has configured, so this mirrors the frontend's own hardcoded API
// base (see the `const API` in browse.html/index.html) rather than adding
// a new required var for a URL that's already fixed in practice.
const API_URL = process.env.API_URL || 'https://api.isitstillgood.com/api';

// ─── Send via Resend API ──────────────────────────────────────────────────────
// We call the Resend REST API directly with fetch() rather than their SDK
// to keep the dependency simple and avoid version conflicts.
async function sendEmail({ to, subject, html }) {
  // If no API key is configured, log the email to console instead of failing.
  // This lets the rest of the invite flow work during development/testing.
  // Debug: log what env vars are visible at runtime
  console.log('[Email] RESEND_API_KEY present:', !!process.env.RESEND_API_KEY);
  console.log('[Email] RESEND_API_KEY length:', process.env.RESEND_API_KEY?.length || 0);
  console.log('[Email] NODE_ENV:', process.env.NODE_ENV);

  if (!process.env.RESEND_API_KEY) {
    console.log('📧 [Email — no RESEND_API_KEY set, logging instead]');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:    ${html.replace(/<[^>]+>/g, '').slice(0, 200)}...`);
    return { id: 'dev-mode', simulated: true };
  }

  // Call the Resend /emails endpoint
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      // Resend requires Bearer auth with your API key
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to,
      subject,
      html,
    }),
  });

  const data = await response.json();

  // Resend returns a non-2xx status on failure — throw so callers can catch it
  if (!response.ok) {
    throw new Error(`Resend API error: ${data.message || response.statusText}`);
  }

  return data; // { id: 'email_id_from_resend' }
}

// ─── Invite Email ─────────────────────────────────────────────────────────────
// Sends a personalised invitation email to a new user.
//
// Parameters:
//   to           — recipient email address
//   inviterName  — display name of the person sending the invite (e.g. "Marco V.")
//   customMessage — optional personal message the inviter wrote
//   inviteToken  — unique token embedded in the join link
//
// The join link looks like: https://isitstillgood.com/join.html?token=abc123
// When the recipient clicks it and creates an account, we auto-friend them.
async function sendInviteEmail({ to, inviterName, customMessage, inviteToken }) {
  const joinUrl = `${SITE_URL}/join.html?token=${inviteToken}`;

  // Default message shown if the inviter didn't write a custom one
  const defaultMessage = `I've been using Is It (Still) Good to track and share reviews of movies, books, TV shows, and video games with friends. I thought you'd enjoy it — come join!`;

  const messageToShow = customMessage?.trim() || defaultMessage;

  // Build the HTML email. We keep it simple and text-heavy so it lands in inbox
  // rather than promotions/spam. Minimal images, clear CTA button.
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're invited to Is It (Still) Good</title>
</head>
<body style="margin:0;padding:0;background:#F5EFE0;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5EFE0;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFCF5;border:1px solid #D9CEBC;border-radius:12px;overflow:hidden;">
          
          <!-- Header -->
          <tr>
            <td style="background:#1C1710;padding:24px 32px;border-bottom:3px solid #C8832A;">
              <p style="margin:0;font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#F5EFE0;">
                Is It <em style="color:#E8A84A;">(Still)</em> Good
              </p>
              <p style="margin:4px 0 0;font-family:monospace;font-size:11px;letter-spacing:0.1em;color:rgba(245,239,224,0.5);text-transform:uppercase;">
                Is it worth your time?
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:18px;color:#1C1710;">
                <strong>${escapeHtml(inviterName)}</strong> invited you to join
              </p>

              <!-- Personal message in a blockquote style -->
              <blockquote style="margin:0 0 24px;padding:14px 18px;background:#F5EFE0;border-left:3px solid #C8832A;border-radius:0 8px 8px 0;font-style:italic;color:#3D3526;font-size:15px;line-height:1.6;">
                "${escapeHtml(messageToShow)}"
              </blockquote>

              <p style="margin:0 0 24px;font-size:14px;color:#7A6E5A;line-height:1.6;">
                Is It (Still) Good is a social review site for movies, books, TV shows, and video games. 
                Rate what you've watched, read, and played — and see what your friends think too.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background:#C8832A;border-radius:8px;padding:0;">
                    <a href="${joinUrl}" 
                       style="display:inline-block;padding:14px 28px;color:#1C1710;font-family:Georgia,serif;font-weight:bold;font-size:16px;text-decoration:none;">
                      Accept Invite &amp; Join →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Fallback link in case button doesn't render -->
              <p style="margin:0 0 8px;font-size:12px;color:#7A6E5A;">
                Or copy this link into your browser:
              </p>
              <p style="margin:0;font-size:11px;color:#C8832A;word-break:break-all;font-family:monospace;">
                ${joinUrl}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px;border-top:1px solid #D9CEBC;background:#FAF7F2;">
              <p style="margin:0;font-size:11px;color:#7A6E5A;font-family:monospace;letter-spacing:0.05em;">
                This invite was sent by ${escapeHtml(inviterName)} via IsItStillGood.com. 
                This link expires in 7 days.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendEmail({ to, subject: `${inviterName} invited you to Is It (Still) Good`, html });
}

// ─── Helper: escape HTML entities in user-provided strings ───────────────────
// Prevents XSS if someone puts <script> tags in their display name or message
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Shared transactional-email shell ─────────────────────────────────────
// Same visual language as the invite email above — pulled out here since the
// verification/email-change notices below need the same header/footer/CTA
// chrome three separate times.
function buildEmailHtml({ title, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  const ctaHtml = ctaUrl ? `
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background:#C8832A;border-radius:8px;padding:0;">
                    <a href="${ctaUrl}"
                       style="display:inline-block;padding:14px 28px;color:#1C1710;font-family:Georgia,serif;font-weight:bold;font-size:16px;text-decoration:none;">
                      ${escapeHtml(ctaLabel)} →
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:12px;color:#7A6E5A;">
                Or copy this link into your browser:
              </p>
              <p style="margin:0;font-size:11px;color:#C8832A;word-break:break-all;font-family:monospace;">
                ${ctaUrl}
              </p>` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#F5EFE0;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5EFE0;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFCF5;border:1px solid #D9CEBC;border-radius:12px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#1C1710;padding:24px 32px;border-bottom:3px solid #C8832A;">
              <p style="margin:0;font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#F5EFE0;">
                Is It <em style="color:#E8A84A;">(Still)</em> Good
              </p>
              <p style="margin:4px 0 0;font-family:monospace;font-size:11px;letter-spacing:0.1em;color:rgba(245,239,224,0.5);text-transform:uppercase;">
                Is it worth your time?
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              ${bodyHtml}
              ${ctaHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px;border-top:1px solid #D9CEBC;background:#FAF7F2;">
              <p style="margin:0;font-size:11px;color:#7A6E5A;font-family:monospace;letter-spacing:0.05em;">
                ${footerNote || 'IsItStillGood.com'}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Registration verification email ──────────────────────────────────────
// Sent right after POST /api/auth/register, before the account can log in.
// Clicking flips isVerified — see GET /api/auth/verify-email.
async function sendVerificationEmail({ to, displayName, token }) {
  const verifyUrl = `${API_URL}/auth/verify-email?token=${token}`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:18px;color:#1C1710;">
      Welcome, <strong>${escapeHtml(displayName)}</strong> —
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#3D3526;line-height:1.6;">
      Confirm your email address to activate your account and start rating what you've watched, read, and played.
    </p>`;
  const html = buildEmailHtml({
    title: 'Confirm your email — Is It (Still) Good',
    bodyHtml,
    ctaLabel: 'Confirm Email',
    ctaUrl: verifyUrl,
    footerNote: "This link expires in 24 hours. If you didn't create this account, you can ignore this email.",
  });
  return sendEmail({ to, subject: 'Confirm your email to activate your account', html });
}

// ─── Email-change confirmation — sent to the NEW address ──────────────────
// Clicking swaps User.email to the new address — see GET /api/auth/verify-email.
async function sendEmailChangeConfirmation({ to, displayName, token }) {
  const verifyUrl = `${API_URL}/auth/verify-email?token=${token}`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:18px;color:#1C1710;">
      Hi <strong>${escapeHtml(displayName)}</strong> —
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#3D3526;line-height:1.6;">
      Someone requested to change the email address on an Is It (Still) Good account to this one. Confirm below to make the switch.
    </p>`;
  const html = buildEmailHtml({
    title: 'Confirm your new email — Is It (Still) Good',
    bodyHtml,
    ctaLabel: 'Confirm New Email',
    ctaUrl: verifyUrl,
    footerNote: "This link expires in 24 hours. If you didn't request this, ignore this email — your address on file stays unchanged.",
  });
  return sendEmail({ to, subject: 'Confirm your new email address', html });
}

// ─── Email-change heads-up — sent to the OLD address, no action needed ────
// Pure notice, no token/link — lets the real owner notice and react if a
// stolen session tried to move the account to an address they don't control.
async function sendEmailChangeNotice({ to, displayName, newEmail }) {
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:18px;color:#1C1710;">
      Hi <strong>${escapeHtml(displayName)}</strong> —
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#3D3526;line-height:1.6;">
      A request was made to change the email address on your Is It (Still) Good account to
      <strong>${escapeHtml(newEmail)}</strong>. Nothing has changed yet — the switch only takes
      effect once that address confirms it.
    </p>
    <p style="margin:0;font-size:14px;color:#3D3526;line-height:1.6;">
      If this wasn't you, change your password right away.
    </p>`;
  const html = buildEmailHtml({
    title: 'Email change requested — Is It (Still) Good',
    bodyHtml,
    footerNote: "This is a notice only — no action is needed if you made this request.",
  });
  return sendEmail({ to, subject: 'Email change requested on your account', html });
}

// ─── New message notification ─────────────────────────────────────────────
// Sent from POST /api/messages when the recipient has emailOnMessage:true
// (the default — see the schema comment on User.emailOnMessage). Fire-and-
// forget, same as the in-app notification it's sent alongside; a failure
// here should never block the message itself from sending.
async function sendNewMessageEmail({ to, displayName, fromDisplayName, fromUsername, preview }) {
  const messagesUrl = `${SITE_URL}/messages.html?with=${encodeURIComponent(fromUsername)}`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:18px;color:#1C1710;">
      Hi <strong>${escapeHtml(displayName)}</strong> —
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#3D3526;line-height:1.6;">
      <strong>${escapeHtml(fromDisplayName)}</strong> sent you a message on Is It (Still) Good:
    </p>
    <p style="margin:0 0 24px;padding:12px 16px;background:#F5EFE0;border-left:3px solid #C8832A;font-size:14px;color:#3D3526;line-height:1.6;font-style:italic;">
      "${escapeHtml(preview)}${preview.length >= 80 ? '…' : ''}"
    </p>`;
  const html = buildEmailHtml({
    title: `${fromDisplayName} sent you a message — Is It (Still) Good`,
    bodyHtml,
    ctaLabel: 'Reply',
    ctaUrl: messagesUrl,
    footerNote: 'You can turn these emails off anytime in your profile settings.',
  });
  return sendEmail({ to, subject: `${fromDisplayName} sent you a message`, html });
}

// ─── Friend request notifications ─────────────────────────────────────────
// Both sent from src/routes/friends.js when the recipient has
// emailOnFriendRequest:true (the default — see the schema comment on
// User.emailOnFriendRequest), and both fire-and-forget like the message
// email above: a delivery failure must never fail the request itself.
//
// The two halves point at different places on purpose. A pending request is
// acted on from the Friends page, so that's where the incoming one sends
// you; once you're actually friends, the interesting thing is the profile
// that just opened up, so the acceptance links straight to it.
async function sendFriendRequestEmail({ to, displayName, fromDisplayName, fromUsername }) {
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:18px;color:#1C1710;">
      Hi <strong>${escapeHtml(displayName)}</strong> —
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#3D3526;line-height:1.6;">
      <strong>${escapeHtml(fromDisplayName)}</strong> (@${escapeHtml(fromUsername)})
      wants to be friends on Is It (Still) Good. Once you accept, their reviews
      start showing up in your feed — and yours in theirs.
    </p>`;
  const html = buildEmailHtml({
    title: `${fromDisplayName} sent you a friend request — Is It (Still) Good`,
    bodyHtml,
    ctaLabel: 'View request',
    ctaUrl: `${SITE_URL}/friends.html`,
    footerNote: 'You can turn these emails off anytime in your profile settings.',
  });
  return sendEmail({ to, subject: `${fromDisplayName} sent you a friend request`, html });
}

async function sendFriendAcceptedEmail({ to, displayName, friendDisplayName, friendUsername }) {
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:18px;color:#1C1710;">
      Hi <strong>${escapeHtml(displayName)}</strong> —
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#3D3526;line-height:1.6;">
      <strong>${escapeHtml(friendDisplayName)}</strong> accepted your friend
      request. You'll start seeing their reviews in your feed.
    </p>`;
  const html = buildEmailHtml({
    title: `${friendDisplayName} accepted your friend request — Is It (Still) Good`,
    bodyHtml,
    ctaLabel: `View ${friendDisplayName}'s profile`,
    ctaUrl: `${SITE_URL}/profile.html?username=${encodeURIComponent(friendUsername)}`,
    footerNote: 'You can turn these emails off anytime in your profile settings.',
  });
  return sendEmail({ to, subject: `${friendDisplayName} accepted your friend request`, html });
}

module.exports = {
  sendEmail, sendInviteEmail,
  sendVerificationEmail, sendEmailChangeConfirmation, sendEmailChangeNotice,
  sendNewMessageEmail,
  sendFriendRequestEmail, sendFriendAcceptedEmail,
};
