// src/routes/visits.js — first-party record of who actually arrived.
//
// Exists because 311 ad clicks produced no signups and nothing on our side
// could say whether anyone had landed at all. Attribution is only written when
// somebody registers, so every visitor who leaves was invisible, and the only
// other number available came from the ad platform being questioned.
//
// What this deliberately does NOT record is as important as what it does: no
// IP address, no user-agent string, no full referrer, and no link to a signed-
// in account. See the VisitLog model for the reasoning. It answers "how many
// people, from where, landing on what, and did they go any further" — and it
// cannot answer "which person", by construction.

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');

// Unauthenticated and free to call, so it needs a ceiling. Generous enough for
// real browsing — a person clicking through twenty pages in a minute is
// ordinary — and low enough that it cannot be used to inflate the numbers or
// fill the disk, which this database has run out of before.
const visitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  // A rejected beacon must cost the visitor nothing: no error, no retry.
  handler: (req, res) => res.status(204).end(),
});

// Crawlers execute JavaScript now, so they fire the pixel and would land here
// exactly like a person. Flagged rather than dropped — "how much of this is
// automated" turned out to be the actual question, and a row that is never
// recorded cannot answer it.
const BOT = /bot|crawl|spider|slurp|bingpreview|headless|phantom|puppeteer|playwright|lighthouse|curl|wget|python-requests|node-fetch|axios|monitor|uptime|pingdom|semrush|ahrefs|dataprovider|facebookexternalhit|preview/i;

function deviceFrom(ua = '') {
  if (/ipad|tablet|playbook|silk/i.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Only the host. "google.com" is useful; the full URL can carry what somebody
// searched for, which is none of our business.
function hostOf(raw) {
  if (!raw) return null;
  try { return new URL(raw).hostname.replace(/^www\./, '').slice(0, 120) || null; }
  catch { return null; }
}

const clamp = (v, n) => {
  const s = String(v ?? '').trim().slice(0, n);
  return s || null;
};

// ─── POST /api/visits ───────────────────────────────────────────────────────
// Fire-and-forget. Always 204, even on bad input: this is a beacon, and a
// visitor must never see a failure from it or be slowed down waiting.
router.post('/', visitLimiter, [
  body('path').optional().isString(),
  body('source').optional().isString(),
  body('medium').optional().isString(),
  body('campaign').optional().isString(),
  body('content').optional().isString(),
  body('rdt_cid').optional().isString(),
  body('fbclid').optional().isString(),
  body('referrer').optional().isString(),
  body('sessionId').optional().isString(),
], async (req, res) => {
  res.status(204).end();                 // answer first, write after

  if (!validationResult(req).isEmpty()) return;

  try {
    const b = req.body || {};
    const ua = String(req.get('user-agent') || '');
    const rdt = clamp(b.rdt_cid, 255);
    const fb = clamp(b.fbclid, 255);

    await prisma.visitLog.create({
      data: {
        path: clamp(b.path, 300) || '/',
        source: clamp(b.source, 120),
        medium: clamp(b.medium, 120),
        campaign: clamp(b.campaign, 200),
        content: clamp(b.content, 200),
        clickId: rdt || fb,
        clickNetwork: rdt ? 'reddit' : fb ? 'meta' : null,
        referrerHost: hostOf(b.referrer),
        // Cloudflare stamps this at the edge on every origin request — the
        // same header geo.php already reads. Coarse enough to be safe.
        country: clamp(req.get('cf-ipcountry'), 2),
        device: deviceFrom(ua),
        bot: BOT.test(ua),
        sessionId: clamp(b.sessionId, 40),
      },
    });
  } catch (err) {
    // Logging a visit must never be able to affect a visit.
    console.error('visit log failed', err.message);
  }
});

module.exports = router;
