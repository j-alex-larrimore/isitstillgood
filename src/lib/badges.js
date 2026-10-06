// src/lib/badges.js — what a badge is, and who has earned one.
//
// Recognition for the people writing reviews before there is any reason to.
// A catalogue of 70,719 titles carrying about a thousand reviews does not read
// as a quiet room to a new visitor, it reads as an empty one — and the people
// fixing that are doing it with nothing in return yet. This is the something.
//
// Definitions live here rather than in the schema on purpose: thresholds and
// wording are product decisions that get tuned, and adding a badge should be a
// code change, never a migration. UserBadge only records that a user holds a
// code.
//
// Everything here is derived from reviews that are actually visible — published
// and public. A private review is a real contribution to the person who wrote
// it but not to the catalogue, and a badge that counts drafts would be earned
// by writing nothing.

const PIONEER_LIMIT = 100;

// Tiered badges keep one row whose tier climbs, rather than one row per tier.
const CRITIC_TIERS   = [10, 50, 100];
const WORDSMITH_MIN  = 10;
// Pathfinder is tiered rather than a single award because there are ~69,700
// titles with no review at all: being first once is a nice accident, being
// first a hundred times is the behaviour the catalogue actually needs.
const PATHFINDER_TIERS = [1, 25, 100];
const MEDIA_TYPES    = ['MOVIE', 'TV_SHOW', 'BOOK', 'VIDEO_GAME'];

const BADGES = {
  PIONEER: {
    label: 'Pioneer',
    // Shown as "Pioneer #12". The number is the point: it says you were here
    // before anyone had a reason to be.
    numbered: true,
    blurb: n => `One of the first ${PIONEER_LIMIT} people to review anything here`,
    earned: s => (s.publishedReviews > 0 ? { number: s.pioneerNumber } : null),
  },

  CRITIC: {
    label: 'Critic',
    tiers: CRITIC_TIERS,
    blurb: t => `Written ${CRITIC_TIERS[t - 1]} reviews`,
    earned: s => {
      let tier = 0;
      CRITIC_TIERS.forEach((n, i) => { if (s.publishedReviews >= n) tier = i + 1; });
      return tier ? { tier } : null;
    },
  },

  PATHFINDER: {
    label: 'Pathfinder',
    tiers: PATHFINDER_TIERS,
    blurb: t => {
      const n = PATHFINDER_TIERS[(t || 1) - 1];
      return n === 1
        ? 'First to review something nobody had reviewed'
        : `First to review ${n} titles nobody had reviewed`;
    },
    earned: s => {
      let tier = 0;
      PATHFINDER_TIERS.forEach((n, i) => { if (s.firstReviews >= n) tier = i + 1; });
      return tier ? { tier } : null;
    },
  },

  OMNIVORE: {
    label: 'Omnivore',
    // The badge for the thing this site can do that Letterboxd and Goodreads
    // cannot: one opinion-holder across all four kinds of thing.
    blurb: () => 'Reviewed a film, a show, a book and a game',
    earned: s => (MEDIA_TYPES.every(t => s.typesReviewed.has(t)) ? {} : null),
  },

  WORDSMITH: {
    label: 'Wordsmith',
    // A rating is a number; a review is the content. This counts only the
    // latter, and deliberately ignores how long the writing is — policing
    // length would just teach people to pad.
    blurb: () => `Written ${WORDSMITH_MIN} reviews with actual words in them`,
    earned: s => (s.writtenReviews >= WORDSMITH_MIN ? {} : null),
  },
};

// Everything the rules above need, gathered in one pass per user.
async function statsFor(prisma, userId) {
  const visible = { userId, isDraft: false, visibility: 'PUBLIC' };

  const [publishedReviews, writtenReviews, firstReviews, types] = await Promise.all([
    prisma.review.count({ where: visible }),
    prisma.review.count({ where: { ...visible, reviewText: { not: null } } }),
    // Counted from the flag on the review rather than recomputed, so the
    // account badge and the marker on the review can never disagree.
    prisma.review.count({ where: { ...visible, isFirstReview: true } }),
    prisma.review.findMany({
      where: visible,
      select: { mediaItem: { select: { mediaType: true } } },
      distinct: ['mediaItemId'],
    }),
  ]);

  return {
    publishedReviews,
    writtenReviews,
    firstReviews,
    typesReviewed: new Set(types.map(r => r.mediaItem.mediaType)),
  };
}

// The next Pioneer number, or null once they are gone.
//
// Counted from badges already awarded rather than from users-who-have-reviewed,
// so the number a person was given is theirs permanently: if Pioneer #3 later
// deletes every review they wrote, #4 does not quietly become #3.
async function nextPioneerNumber(prisma) {
  const taken = await prisma.userBadge.count({ where: { code: 'PIONEER' } });
  return taken < PIONEER_LIMIT ? taken + 1 : null;
}

// Work out what a user should hold and write the difference.
//
// Safe to run repeatedly — it awards what is missing, raises a tier that has
// climbed, and never removes anything. Losing a badge because a review was
// edited would be a worse experience than briefly holding one you no longer
// strictly qualify for.
async function syncBadges(prisma, userId) {
  const stats = await statsFor(prisma, userId);
  const held = await prisma.userBadge.findMany({ where: { userId } });
  const heldBy = new Map(held.map(b => [b.code, b]));
  const awarded = [];

  for (const [code, def] of Object.entries(BADGES)) {
    // Pioneer needs a number, and only if there is one left to give.
    if (code === 'PIONEER' && !heldBy.has('PIONEER')) {
      if (stats.publishedReviews < 1) continue;
      const number = await nextPioneerNumber(prisma);
      if (!number) continue;
      try {
        await prisma.userBadge.create({ data: { userId, code, number } });
        awarded.push({ code, number });
      } catch (e) {
        // Unique constraint: two reviews landing at once. Already held, fine.
        if (e.code !== 'P2002') throw e;
      }
      continue;
    }
    if (code === 'PIONEER') continue;

    const result = def.earned(stats);
    if (!result) continue;
    const existing = heldBy.get(code);

    if (!existing) {
      try {
        await prisma.userBadge.create({ data: { userId, code, tier: result.tier ?? null } });
        awarded.push({ code, tier: result.tier });
      } catch (e) { if (e.code !== 'P2002') throw e; }
    } else if (result.tier && (existing.tier ?? 0) < result.tier) {
      await prisma.userBadge.update({ where: { id: existing.id }, data: { tier: result.tier } });
      awarded.push({ code, tier: result.tier });
    }
  }

  return awarded;
}

// Shape a stored row for the API and the page.
function presentBadge(row) {
  const def = BADGES[row.code];
  if (!def) return null;
  const roman = ['', 'I', 'II', 'III', 'IV', 'V'];
  return {
    code: row.code,
    label: def.numbered && row.number ? `${def.label} #${row.number}`
      : row.tier ? `${def.label} ${roman[row.tier] || row.tier}`
      : def.label,
    blurb: def.blurb(row.tier),
    tier: row.tier ?? null,
    number: row.number ?? null,
    earnedAt: row.earnedAt,
  };
}

module.exports = {
  BADGES, PIONEER_LIMIT, CRITIC_TIERS, WORDSMITH_MIN, PATHFINDER_TIERS,
  statsFor, nextPioneerNumber, syncBadges, presentBadge,
};
