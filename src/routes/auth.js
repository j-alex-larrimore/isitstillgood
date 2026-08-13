// src/routes/auth.js
const router   = require('express').Router();
const passport = require('../middleware/passport');
const bcrypt   = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const prisma   = require('../lib/prisma');
const { signAccessToken, issueRefreshToken, rotateRefreshToken, setAuthCookies, clearAuthCookies } = require('../lib/tokens');
const { requireAuth } = require('../middleware/auth');
const { sendVerificationEmail, sendEmailChangeConfirmation, sendEmailChangeNotice } = require('../services/email');

const CLIENT_URL = process.env.CLIENT_URL || 'https://isitstillgood.com';
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Creates a fresh email-verification token for a user, clearing out any
// stale ones first — a user can only have one live token at a time, so an
// old "check your email" link can't be used after a newer one was issued.
async function issueVerificationToken(userId, newEmail = null) {
  // Clear prior tokens of the SAME kind — registration tokens don't touch a
  // live change-email token and vice versa, but a second change-email
  // request (even to a different address) replaces the first rather than
  // leaving two live tokens pointed at two different addresses.
  await prisma.emailVerificationToken.deleteMany({
    where: newEmail ? { userId, newEmail: { not: null } } : { userId, newEmail: null },
  });
  return prisma.emailVerificationToken.create({
    data: { userId, newEmail, expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS) },
  });
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
// Per-IP throttles on the two endpoints a scripted bot would actually hit —
// mass account creation and credential-stuffing/brute-force login. Google
// OAuth isn't limited here: it requires a real Google account per attempt,
// so it isn't a practical scripted-abuse vector the way email/password is.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this network. Please try again later.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
    return false;
  }
  return true;
}

async function sendAuthResponse(res, user) {
  const accessToken  = signAccessToken(user.id);
  const refreshToken = await issueRefreshToken(user.id);
  setAuthCookies(res, accessToken, refreshToken);

  // Fetch the full user record to ensure we have isAdmin and all fields.
  // We do this because the user object passed in may come from passport
  // or prisma.user.create which may not always include all fields.
  const fullUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true, email: true, username: true,
      displayName: true, avatarUrl: true, isAdmin: true,
      defaultVisibility: true, profilePublic: true,
      excludedFriends: true, consumedWithin: true,
    },
  });

  res.json({
    user: fullUser,
    accessToken,
    // Also return the refresh token in the body as a fallback for clients
    // where the cookie cannot be set cross-site (e.g. some browser configs)
    refreshToken,
  });
}

// ─── POST /api/auth/register ─────────────────────────────────────────────────
router.post('/register', registerLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('username').matches(/^[a-zA-Z0-9_]{3,30}$/).withMessage('Username: 3-30 chars, letters/numbers/underscores only'),
  body('displayName').trim().isLength({ min: 1, max: 60 }),
], async (req, res, next) => {
  // Honeypot: join.html has a "website" field hidden off-screen that a real
  // user never sees or fills, but a scripted form-filler often does. Report
  // a normal-looking success without creating anything, so the bot has no
  // signal to adapt on.
  if (req.body.website) {
    return res.status(200).json({ message: 'Registration received' });
  }
  if (!validate(req, res)) return;
  const { email, password, username, displayName } = req.body;
  try {
    const exists = await prisma.user.findFirst({
      where: { OR: [{ email: email.toLowerCase() }, { username }] },
    });
    if (exists) {
      return res.status(409).json({ error: exists.email === email.toLowerCase() ? 'Email already registered' : 'Username taken' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        username,
        displayName,
        passwordHash,
        // isVerified defaults to false — no session is issued below until
        // they click the confirmation link (see GET /verify-email).
        lists: {
          create: [
            { title: 'Want to Watch / Read / Play', isPublic: true },
            { title: 'All-Time Favorites',          isPublic: true },
          ],
        },
      },
    });

    const verificationToken = await issueVerificationToken(user.id);
    await sendVerificationEmail({ to: user.email, displayName: user.displayName, token: verificationToken.token });

    res.status(201).json({
      message: 'Account created — check your email to confirm and log in.',
      requiresVerification: true,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', loginLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  passport.authenticate('local', { session: false }, async (err, user, info) => {
    if (err)   return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    if (!user.isVerified) {
      return res.status(403).json({ error: 'Please confirm your email before logging in.', code: 'EMAIL_NOT_VERIFIED' });
    }
    try {
      await sendAuthResponse(res, user);
    } catch (e) { next(e); }
  })(req, res, next);
});

// ─── POST /api/auth/resend-verification ──────────────────────────────────────
// For a user who lost/deleted the original confirmation email. Always
// responds with the same generic message regardless of whether the address
// exists or is already verified, so this can't be used to enumerate accounts.
const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many resend attempts. Please try again later.' },
});
router.post('/resend-verification', resendLimiter, [
  body('email').isEmail().normalizeEmail(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const user = await prisma.user.findUnique({ where: { email: req.body.email.toLowerCase() } });
    if (user && !user.isVerified && !user.canceledAt) {
      const verificationToken = await issueVerificationToken(user.id);
      await sendVerificationEmail({ to: user.email, displayName: user.displayName, token: verificationToken.token });
    }
    res.json({ message: 'If that email needs verification, a new confirmation link is on its way.' });
  } catch (err) { next(err); }
});

// ─── GET /api/auth/verify-email ───────────────────────────────────────────────
// The link a user clicks from their inbox — no frontend JS involved, this
// does the DB work directly and redirects back to the site with a status
// flag. Handles both flows: newEmail:null confirms a fresh registration;
// newEmail:<address> completes a pending email-address change.
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  const fail = (reason) => res.redirect(`${CLIENT_URL}/index.html?verified=0&reason=${reason}`);
  if (!token) return fail('missing_token');
  try {
    const record = await prisma.emailVerificationToken.findUnique({ where: { token } });
    if (!record) return fail('invalid_token');
    if (record.expiresAt < new Date()) {
      await prisma.emailVerificationToken.delete({ where: { id: record.id } }).catch(() => {});
      return fail('expired');
    }

    if (record.newEmail) {
      // Email-change flow — guard against the new address being claimed by
      // someone else in the window between the request and the click.
      const taken = await prisma.user.findFirst({ where: { email: record.newEmail, NOT: { id: record.userId } } });
      if (taken) return fail('email_taken');
      await prisma.user.update({ where: { id: record.userId }, data: { email: record.newEmail } });
      await prisma.emailVerificationToken.delete({ where: { id: record.id } });
      return res.redirect(`${CLIENT_URL}/index.html?emailChanged=1`);
    }

    // Registration flow
    await prisma.user.update({ where: { id: record.userId }, data: { isVerified: true } });
    await prisma.emailVerificationToken.delete({ where: { id: record.id } });
    return res.redirect(`${CLIENT_URL}/index.html?verified=1`);
  } catch (err) {
    return fail('server_error');
  }
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  const oldToken = req.cookies?.refresh_token || req.body?.refreshToken;
  if (!oldToken) return res.status(401).json({ error: 'No refresh token' });
  try {
    const newRefreshToken = await rotateRefreshToken(oldToken);
    const record = await prisma.refreshToken.findUnique({ where: { token: newRefreshToken } });
    const accessToken = signAccessToken(record.userId);
    setAuthCookies(res, accessToken, newRefreshToken);
    res.json({ accessToken });
  } catch (err) {
    clearAuthCookies(res);
    next(err);
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const token = req.cookies?.refresh_token || req.body?.refreshToken;
    if (token) {
      await prisma.refreshToken.deleteMany({ where: { token } }).catch(() => {});
    }
    clearAuthCookies(res);
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/logout-all ────────────────────────────────────────────────
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await prisma.refreshToken.deleteMany({ where: { userId: req.user.id } });
    clearAuthCookies(res);
    res.json({ message: 'Logged out of all devices' });
  } catch (err) { next(err); }
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ─── GET /api/auth/google ──── Redirect to Google ────────────────────────────
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// ─── GET /api/auth/google/callback ───────────────────────────────────────────
router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${process.env.CLIENT_URL}/login?error=google_failed` }),
  async (req, res, next) => {
    try {
      const accessToken  = signAccessToken(req.user.id);
      const refreshToken = await issueRefreshToken(req.user.id);
      setAuthCookies(res, accessToken, refreshToken);
      // Redirect to frontend — it will read the cookie
      res.redirect(`${process.env.CLIENT_URL}/index.html?google=true&token=${accessToken}&refresh=${encodeURIComponent(refreshToken)}`);
    } catch (err) { next(err); }
  }
);

// ─── PATCH /api/auth/change-password ─────────────────────────────────────────
router.patch('/change-password', requireAuth, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  const { currentPassword, newPassword } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.passwordHash) return res.status(400).json({ error: 'Account uses Google login only' });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });
    // Revoke all sessions
    await prisma.refreshToken.deleteMany({ where: { userId: req.user.id } });
    clearAuthCookies(res);
    res.json({ message: 'Password updated. Please log in again.' });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/change-email ─────────────────────────────────────────────
// Doesn't write the new address directly — issues a confirmation token to
// the new address (same as registration) and only swaps User.email once
// that link is clicked. A heads-up (no link, no action) also goes to the
// OLD address so the real owner notices if a stolen session tried this.
router.post('/change-email', requireAuth, [
  body('newEmail').isEmail().normalizeEmail(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  const newEmail = req.body.newEmail.toLowerCase();
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.passwordHash) {
      if (!req.body.currentPassword) return res.status(400).json({ error: 'Current password required' });
      const valid = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    }
    if (newEmail === user.email) return res.status(400).json({ error: "That's already your current email" });
    const taken = await prisma.user.findFirst({ where: { email: newEmail, NOT: { id: user.id } } });
    if (taken) return res.status(409).json({ error: 'Email already in use by another account' });

    const verificationToken = await issueVerificationToken(user.id, newEmail);
    await sendEmailChangeConfirmation({ to: newEmail, displayName: user.displayName, token: verificationToken.token });
    // Best-effort — the heads-up notice shouldn't block the actual request.
    sendEmailChangeNotice({ to: user.email, displayName: user.displayName, newEmail }).catch(() => {});

    res.json({ message: `Check ${newEmail} for a link to confirm the change.` });
  } catch (err) { next(err); }
});

module.exports = router;
