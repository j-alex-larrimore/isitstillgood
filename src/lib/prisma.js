// src/lib/prisma.js  — single shared PrismaClient instance
const { PrismaClient } = require('@prisma/client');

const base = global.__prismaBase ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Read operations that accept an arbitrary `where`. findUnique/findUniqueOrThrow
// are deliberately absent: their `where` only takes unique fields, so injecting
// a filter there is a Prisma validation error. The handful of findUnique call
// sites check isDraft themselves.
const FILTERABLE_READS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy',
]);

// ─── Drafts are invisible by default ──────────────────────────────────────
// An unpublished review lives in the Review table behind an isDraft flag, so
// every existing read — feeds, profiles, rating averages, verdict counts, the
// crawler-facing pages — would surface it unless filtered. That's 40-odd query
// sites across seven route files, and missing one doesn't fail loudly: it
// publishes someone's half-written review, or folds a placeholder rating into
// a public average.
//
// So the filter is applied here instead of at each call site. Reads through
// this client cannot see drafts, whether or not the author of a given query
// remembered them. Anything that genuinely needs to see a draft — the author
// fetching their own — uses prismaWithDrafts below, which is greppable and
// rare by design.
//
// Note this covers top-level prisma.review.* only. A nested read
// (mediaItem.findMany({ _count: { select: { reviews: … } } })) runs as a
// mediaItem operation and still needs isDraft: false in its own where clause.
const prisma = global.__prisma ?? base.$extends({
  query: {
    review: {
      async $allOperations({ operation, args, query }) {
        if (!FILTERABLE_READS.has(operation)) return query(args);
        const next = { ...args };
        next.where = next.where ? { AND: [next.where, { isDraft: false }] } : { isDraft: false };
        return query(next);
      },
    },
  },
});

// Unfiltered client. Only for reading or writing a user's own drafts — every
// other use is a bug waiting to surface a draft publicly.
const prismaWithDrafts = base;

if (process.env.NODE_ENV !== 'production') {
  global.__prismaBase = base;
  global.__prisma = prisma;
}

module.exports = prisma;
module.exports.prismaWithDrafts = prismaWithDrafts;
