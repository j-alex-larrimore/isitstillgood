// src/middleware/admin.js
const { requireAuth } = require('./auth');

async function requireAdmin(req, res, next) {
  // First run the normal auth check
  requireAuth(req, res, async () => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = { requireAdmin };
