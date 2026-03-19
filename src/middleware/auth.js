// src/middleware/auth.js  — JWT guard for protected routes
const jwt  = require('jsonwebtoken');
const prisma = require('../lib/prisma');

/**
 * requireAuth — verifies the JWT from Authorization header or httpOnly cookie.
 * Sets req.user on success.
 */
async function requireAuth(req, res, next) {
  try {
    let token = null;

    // 1. Bearer token in Authorization header (API / mobile clients)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    // 2. httpOnly cookie (browser clients — more secure)
    if (!token && req.cookies?.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Attach lean user object — re-fetch only what we need
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true, email: true, username: true,
        displayName: true, avatarUrl: true, profilePublic: true,
        defaultVisibility: true, isAdmin: true,
      },
    });

    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * optionalAuth — like requireAuth but won't 401 if no token.
 * Useful for public endpoints that behave differently for logged-in users.
 */
async function optionalAuth(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
    if (!token && req.cookies?.access_token) token = req.cookies.access_token;
    if (!token) return next();

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });
    req.user = user || null;
  } catch {
    req.user = null;
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
