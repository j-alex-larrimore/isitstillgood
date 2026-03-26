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

module.exports = { sendEmail, sendInviteEmail };
