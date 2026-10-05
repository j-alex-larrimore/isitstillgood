// src/middleware/passport.js
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Strategy: LocalStrategy }  = require('passport-local');
const bcrypt = require('bcryptjs');
const prisma  = require('../lib/prisma');

// ─── Serialize / Deserialize (for session — only used during OAuth handshake) ─
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// ─── Local Strategy (email + password) ───────────────────────────────────────
passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (!user || !user.passwordHash) {
        return done(null, false, { message: 'Invalid credentials' });
      }
      // Canceled accounts have passwordHash cleared already, but check
      // canceledAt explicitly too — it's the single source of truth.
      if (user.canceledAt) {
        return done(null, false, { message: 'This account has been canceled' });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return done(null, false, { message: 'Invalid credentials' });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

// ─── Google OAuth 2.0 Strategy ───────────────────────────────────────────────
passport.use(new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL,
    scope: ['profile', 'email'],
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const email    = profile.emails?.[0]?.value?.toLowerCase();
      const googleId = profile.id;
      const avatar   = profile.photos?.[0]?.value;
      const name     = profile.displayName;

      // Cancellation used to be a dead end. The row keeps the email and the
      // username forever, so afterwards Google sign-in was refused here, local
      // login was refused (passwordHash is cleared), and registering again
      // returned "Email already registered" — the same person could never come
      // back under their own address by any route, and the only feedback was a
      // redirect to a page that does not exist.
      //
      // Reactivating is safe precisely because of what cancellation does and
      // does not do: see the comment on DELETE /api/users/:username. Star
      // ratings are NEVER hidden — they stay visible and keep counting toward
      // community scores the entire time an account is canceled. So letting the
      // owner back in exposes nothing that was not already public. Review text
      // was wiped at cancellation and does not come back.
      //
      // Google has just proved ownership of the address, which is a stronger
      // check than the password this account no longer has.
      const reactivate = async (where) => prisma.user.update({
        where,
        data: {
          canceledAt: null, googleId, googleEmail: email,
          avatarUrl: avatar || undefined, isVerified: true,
        },
      });

      // 1. Already linked via Google ID
      let user = await prisma.user.findUnique({ where: { googleId } });
      if (user) {
        if (user.canceledAt) {
          user = await reactivate({ id: user.id });
          user.justReactivated = true;
        }
        return done(null, user);
      }

      // 2. Email exists — link Google to existing account
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        const wasCanceled = !!user.canceledAt;
        user = wasCanceled
          ? await reactivate({ id: user.id })
          : await prisma.user.update({
              where: { email },
              // Google itself just proved ownership of this address, so an
              // existing-but-unverified local account gets verified here too —
              // no reason to make them click a separate email link as well.
              data: { googleId, googleEmail: email, avatarUrl: user.avatarUrl || avatar, isVerified: true },
            });
        if (wasCanceled) user.justReactivated = true;
        return done(null, user);
      }

      // 3. Brand new user — create account
      // Generate a unique username from their name
      const baseUsername = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      let username = baseUsername;
      let suffix = 1;
      while (await prisma.user.findUnique({ where: { username } })) {
        username = `${baseUsername}${suffix++}`;
      }

      user = await prisma.user.create({
        data: {
          email,
          googleId,
          googleEmail: email,
          username,
          displayName: name,
          avatarUrl: avatar,
          isVerified: true,       // Google-verified email
          // Create default lists for the user
          lists: {
            create: [
              { title: 'Want to Watch / Read / Play', isPublic: true },
              { title: 'All-Time Favorites',          isPublic: true },
            ],
          },
        },
      });

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

module.exports = passport;
