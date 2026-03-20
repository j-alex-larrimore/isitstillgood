// src/lib/tokens.js
// Handles JWT access tokens and long-lived refresh tokens.
//
// Token lifetime strategy:
//   - Access token: 7 days by default (was 15 minutes — too short for a consumer site)
//     Override via JWT_EXPIRES_IN env var if you want something different.
//   - Refresh token: 90 days stored in the database.
//     Each time it's used it rotates (old one deleted, new one issued),
//     so as long as the user visits within 90 days they stay logged in.
//   - Cookie maxAge matches the token lifetime so the browser doesn't
//     discard the cookie before the token actually expires.

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('./prisma');

// ─── Access token ─────────────────────────────────────────────────────────────
// A signed JWT sent to the client. Contains the user's ID (sub claim).
// Verified on every authenticated request without hitting the database.
function signAccessToken(userId) {
  return jwt.sign(
    { sub: userId, type: 'access' },
    process.env.JWT_SECRET,
    // Default 7 days — long enough that normal use never feels like being logged out.
    // Can be overridden via JWT_EXPIRES_IN env var (e.g. '1d', '7d', '30d').
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ─── Refresh token ────────────────────────────────────────────────────────────
// A random 64-byte hex string stored in the database.
// Used to get a new access token when the current one expires.
// Lifetime is 90 days — as long as the user visits within that window
// their session silently renews and they never see a login prompt.
async function issueRefreshToken(userId) {
  const token = crypto.randomBytes(64).toString('hex');

  // 90 days from now — generous enough for normal use patterns
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({ data: { token, userId, expiresAt } });
  return token;
}

// ─── Refresh token rotation ───────────────────────────────────────────────────
// When a refresh token is used, we delete it and issue a brand new one.
// This means a stolen refresh token can only be used once before it's invalidated.
// If a token is used twice (replay attack), the second use will fail.
async function rotateRefreshToken(oldToken) {
  const record = await prisma.refreshToken.findUnique({ where: { token: oldToken } });

  // Token doesn't exist or has expired — force re-login
  if (!record || record.expiresAt < new Date()) {
    throw Object.assign(
      new Error('Invalid or expired refresh token'),
      { status: 401 }
    );
  }

  // Delete the old token — it's now consumed
  await prisma.refreshToken.delete({ where: { token: oldToken } });

  // Issue a fresh token — this resets the 90-day window
  return issueRefreshToken(record.userId);
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────
// Sets both tokens as httpOnly cookies so they're not accessible to JavaScript.
// The refresh token cookie is scoped to /api/auth/refresh so it's only sent
// to that endpoint — not every API request.
function setAuthCookies(res, accessToken, refreshToken) {
  const isProduction = process.env.NODE_ENV === 'production';

  // Access token cookie — 7 days, matches the JWT expiry
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure:   isProduction,
    sameSite: isProduction ? 'none' : 'lax', // 'none' needed for cross-site requests
    maxAge:   7 * 24 * 60 * 60 * 1000,       // 7 days in milliseconds
  });

  // Refresh token cookie — 90 days.
  // We no longer scope to /api/auth/refresh because in cross-site setups
  // (DreamHost frontend → Railway API) path-scoped cookies can be dropped
  // by some browsers. We rely on the refresh endpoint checking the token
  // value rather than restricting which requests it's sent with.
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure:   isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge:   90 * 24 * 60 * 60 * 1000,      // 90 days in milliseconds
    // No path restriction — sent on all requests to the API domain
  });
}

function clearAuthCookies(res) {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
}

module.exports = {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  setAuthCookies,
  clearAuthCookies,
};
