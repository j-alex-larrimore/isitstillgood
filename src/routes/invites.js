// src/routes/invites.js
//
// Handles the full email invite flow:
//   1. POST /api/invites        — logged-in user sends an invite to an email address
//   2. GET  /api/invites/check  — check if an invite token is valid (before showing join page)
//   3. POST /api/invites/claim  — after signup, claim the token to auto-friend the inviter

const router  = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const prisma  = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { sendInviteEmail } = require('../services/email');

// ─── Validation helper ────────────────────────────────────────────────────────
function ok(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(422).json({ errors: e.array() }); return false; }
  return true;
}

// ─── POST /api/invites ────────────────────────────────────────────────────────
// Send an invitation to an email address.
//
// Two outcomes:
//   A) Email belongs to an existing user  → send a friend request directly,
//      no email needed (but we still notify them via the notification system).
//   B) Email is new                       → create an InviteToken, send the
//      invite email with a personalised join link.
//
// Body: { email, customMessage? }
router.post('/', requireAuth, [
  // Validate the email is a real email format
  body('email').isEmail().normalizeEmail(),
  // Custom message is optional, max 500 chars to keep emails reasonable
  body('customMessage').optional().trim().isLength({ max: 500 }),
], async (req, res, next) => {
  if (!ok(req, res)) return;

  const { email, customMessage } = req.body;

  // Prevent users from inviting themselves
  if (email.toLowerCase() === req.user.email.toLowerCase()) {
    return res.status(400).json({ error: 'You cannot invite yourself' });
  }

  try {
    // ── Path A: Check if this email belongs to an existing user ──────────────
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, username: true, displayName: true },
    });

    if (existingUser) {
      // User already exists — check if they're already friends or have a pending request
      const existingFriendship = await prisma.friendship.findFirst({
        where: {
          OR: [
            { initiatorId: req.user.id, receiverId: existingUser.id },
            { initiatorId: existingUser.id, receiverId: req.user.id },
          ],
        },
      });

      if (existingFriendship?.status === 'ACCEPTED') {
        // Already friends — no action needed
        return res.json({
          outcome: 'already_friends',
          message: `You're already friends with ${existingUser.displayName}`,
        });
      }

      if (existingFriendship?.status === 'PENDING') {
        // Request already pending
        return res.json({
          outcome: 'already_pending',
          message: `A friend request is already pending with ${existingUser.displayName}`,
        });
      }

      // No existing relationship — send a friend request
      await prisma.friendship.create({
        data: { initiatorId: req.user.id, receiverId: existingUser.id },
      });

      // Notify the existing user of the friend request
      await prisma.notification.create({
        data: {
          userId: existingUser.id,
          type: 'FRIEND_REQUEST',
          payload: {
            fromUserId: req.user.id,
            fromUsername: req.user.username,
            fromDisplayName: req.user.displayName,
          },
        },
      });

      return res.json({
        outcome: 'friend_request_sent',
        message: `${existingUser.displayName} is already on the site — we sent them a friend request!`,
      });
    }

    // ── Path B: New email — create an invite token and send the email ────────

    // Check if this email already has an unexpired, unclaimed invite from this user
    const existingInvite = await prisma.inviteToken.findFirst({
      where: {
        inviterId: req.user.id,
        email: email.toLowerCase(),
        claimed: false,
        expiresAt: { gt: new Date() }, // gt = greater than = not yet expired
      },
    });

    if (existingInvite) {
      const inviteLink = `${process.env.CLIENT_URL || 'https://www.isitstillgood.com'}/join.html?token=${existingInvite.token}`;
      try {
        await sendInviteEmail({
          to: email,
          inviterName: req.user.displayName,
          customMessage,
          inviteToken: existingInvite.token,
        });
        return res.json({ outcome: 'resent', message: `Invite sent to ${email}` });
      } catch (err) {
        console.error('Resend invite email failed:', err.message);
        return res.json({
          outcome: 'invite_created_email_not_sent',
          message: `Invite exists but email failed: ${err.message}`,
          inviteLink,
        });
      }
    }

    // Create a new invite token that expires in 7 days
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invite = await prisma.inviteToken.create({
      data: {
        inviterId: req.user.id,
        email: email.toLowerCase(),
        expiresAt,
      },
    });

    // Send the invite email — wrapped in try/catch so email failures don't
    // crash the request with a 500. Instead we return a clear message and
    // include the invite link so the admin can share it manually.
    let emailResult;
    let emailError = null;
    try {
      emailResult = await sendInviteEmail({
        to: email,
        inviterName: req.user.displayName,
        customMessage,
        inviteToken: invite.token,
      });
    } catch (err) {
      emailError = err.message;
      console.error('Invite email failed:', err.message);
    }

    const inviteLink = `${process.env.CLIENT_URL || 'https://www.isitstillgood.com'}/join.html?token=${invite.token}`;

    // Email failed or was simulated — return the invite link so it can be shared manually
    if (emailError || emailResult?.simulated) {
      return res.status(201).json({
        outcome: 'invite_created_email_not_sent',
        message: emailError
          ? `Invite created but email failed: ${emailError}`
          : `Invite created but email not sent — RESEND_API_KEY not configured.`,
        inviteLink,
      });
    }

    res.status(201).json({
      outcome: 'invite_sent',
      message: `Invite sent to ${email}! The link expires in 7 days.`,
    });

  } catch (err) { next(err); }
});

// ─── GET /api/invites/check?token= ───────────────────────────────────────────
// Called when someone lands on /join.html?token=xxx
// Returns information about the invite so the page can show
// who invited them and personalise the join experience.
router.get('/check', [
  query('token').notEmpty(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const invite = await prisma.inviteToken.findUnique({
      where: { token: req.query.token },
      include: {
        // Include inviter's public profile info to show on the join page
        inviter: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
      },
    });

    // Token doesn't exist
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found or already used' });
    }

    // Token has been used already
    if (invite.claimed) {
      return res.status(410).json({ error: 'This invite has already been used' });
    }

    // Token has expired
    if (invite.expiresAt < new Date()) {
      return res.status(410).json({ error: 'This invite has expired' });
    }

    // Valid token — return enough info for the join page to personalise itself
    res.json({
      valid: true,
      inviter: invite.inviter,
      email: invite.email,           // pre-fill the email field on the join form
      expiresAt: invite.expiresAt,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/invites/claim ──────────────────────────────────────────────────
// Called after a new user registers via an invite link.
// Marks the token as claimed and automatically creates an ACCEPTED friendship
// between the new user and the inviter.
//
// Body: { token, newUserId }
// This is called internally from the auth register flow, but also exposed
// as an endpoint so the frontend can call it after Google OAuth signup.
router.post('/claim', requireAuth, [
  body('token').notEmpty(),
], async (req, res, next) => {
  if (!ok(req, res)) return;
  try {
    const invite = await prisma.inviteToken.findUnique({
      where: { token: req.body.token },
    });

    if (!invite || invite.claimed || invite.expiresAt < new Date()) {
      return res.status(410).json({ error: 'Invalid or expired invite token' });
    }

    // Prevent the inviter from claiming their own invite
    if (invite.inviterId === req.user.id) {
      return res.status(400).json({ error: 'Cannot claim your own invite' });
    }

    // Mark the token as used so it can't be claimed again
    await prisma.inviteToken.update({
      where: { token: req.body.token },
      data: { claimed: true },
    });

    // Create an ACCEPTED friendship directly — no pending step needed
    // since the invite itself is the acceptance of the connection
    await prisma.friendship.upsert({
      where: {
        initiatorId_receiverId: {
          initiatorId: invite.inviterId,
          receiverId: req.user.id,
        },
      },
      update: { status: 'ACCEPTED' }, // upgrade pending to accepted if it exists
      create: {
        initiatorId: invite.inviterId,
        receiverId: req.user.id,
        status: 'ACCEPTED',           // immediately accepted — no request needed
      },
    });

    // Notify the inviter that their invite was accepted
    await prisma.notification.create({
      data: {
        userId: invite.inviterId,
        type: 'INVITE_ACCEPTED',
        payload: {
          newUserId: req.user.id,
          newUserDisplayName: req.user.displayName,
          newUserUsername: req.user.username,
        },
      },
    });

    res.json({ message: 'Invite claimed — you are now friends!', inviterId: invite.inviterId });
  } catch (err) { next(err); }
});

module.exports = router;
