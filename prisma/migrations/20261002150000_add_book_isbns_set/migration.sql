-- Every ISBN-13 known for a work, across all its editions.
--
-- One ISBN per book makes importing almost useless: a Goodreads or StoryGraph
-- export carries the ISBN of the edition that reader shelved, and a work has
-- many. Jurassic Park has 94 editions and 73 distinct ISBN-13s, so matching
-- our single stored value against a reader's single shelved value is about a
-- 1-in-73 shot. Holding the whole set is the only thing that fixes it.
--
-- Additive. The default is an empty array rather than NULL, matching Prisma's
-- convention for scalar lists; Postgres stores a constant default in the
-- catalog, so this does not rewrite the 68,700-row table.
ALTER TABLE "MediaItem" ADD COLUMN     "isbns" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- GIN, not btree: every read is a set overlap (`hasSome` / `&&`) against up to
-- a hundred candidate ISBNs from one import row, never an equality test.
CREATE INDEX "MediaItem_isbns_idx" ON "MediaItem" USING GIN ("isbns");
