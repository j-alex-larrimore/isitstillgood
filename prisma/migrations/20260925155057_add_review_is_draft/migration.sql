-- Unpublished, work-in-progress reviews.
--
-- Additive with a default, so every existing row becomes a published review
-- and no backfill is needed. Reads are filtered in src/lib/prisma.js via a
-- client extension rather than at each of the ~40 review query sites.
ALTER TABLE "Review" ADD COLUMN     "isDraft" BOOLEAN NOT NULL DEFAULT false;

-- Fetching a user's own drafts is the one hot path that filters on this.
CREATE INDEX "Review_userId_isDraft_idx" ON "Review"("userId", "isDraft");
