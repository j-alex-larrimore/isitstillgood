// src/routes/auth.js
const router   = require('express').Router();
const passport = require('../middleware/passport');
const bcrypt   = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const prisma   = require('../lib/prisma');
const { signAccessToken, issueRefreshToken, rotateRefreshToken, setAuthCookies, clearAuthCookies } = require('../lib/tokens');
const { requireAuth } = require('../middleware/auth');

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
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('username').matches(/^[a-zA-Z0-9_]{3,30}$/).withMessage('Username: 3-30 chars, letters/numbers/underscores only'),
  body('displayName').trim().isLength({ min: 1, max: 60 }),
], async (req, res, next) => {
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
        lists: {
          create: [
            { title: 'Want to Watch / Read / Play', isPublic: true },
            { title: 'All-Time Favorites',          isPublic: true },
          ],
        },
      },
    });

    await sendAuthResponse(res, user);
  } catch (err) { next(err); }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  passport.authenticate('local', { session: false }, async (err, user, info) => {
    if (err)   return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    try {
      await sendAuthResponse(res, user);
    } catch (e) { next(e); }
  })(req, res, next);
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

module.exports = router;
