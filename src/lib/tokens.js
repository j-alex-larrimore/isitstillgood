// src/lib/tokens.js
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('./prisma');

/** Issue a short-lived access JWT */
function signAccessToken(userId) {
  return jwt.sign(
    { sub: userId, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
}

/** Issue a long-lived refresh token (stored in DB) */
async function issueRefreshToken(userId) {
  const token     = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await prisma.refreshToken.create({ data: { token, userId, expiresAt } });
  return token;
}

/** Rotate refresh token — old one deleted, new one issued */
async function rotateRefreshToken(oldToken) {
  const record = await prisma.refreshToken.findUnique({ where: { token: oldToken } });
  if (!record || record.expiresAt < new Date()) {
    throw Object.assign(new Error('Invalid or expired refresh token'), { status: 401 });
  }
  await prisma.refreshToken.delete({ where: { token: oldToken } });
  return issueRefreshToken(record.userId);
}

/** Send access token as cookie + return both tokens */
function setAuthCookies(res, accessToken, refreshToken) {
  const isProduction = process.env.NODE_ENV === 'production';

  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure:   isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge:   15 * 60 * 1000,            // 15 min
  });

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure:   isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    path:     '/api/auth/refresh',        // scoped — only sent to refresh endpoint
  });
}

function clearAuthCookies(res) {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
}

module.exports = { signAccessToken, issueRefreshToken, rotateRefreshToken, setAuthCookies, clearAuthCookies };
