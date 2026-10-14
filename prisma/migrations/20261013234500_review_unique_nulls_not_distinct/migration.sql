-- Make Review's uniqueness actually apply to rows with no season.
--
-- @@unique([userId, mediaItemId, seasonNumber]) reads as "one review per
-- person per thing", but Postgres treats NULLs as distinct in a unique
-- index: two rows with the same user and item and seasonNumber NULL do not
-- collide. seasonNumber is NULL for every film, book and game, so for all
-- of those the constraint enforced nothing at all, silently, since the
-- table was created.
--
-- Found live: one reader had two reviews each of Forrest Gump and Toy
-- Story, same rating, 11ms and 4ms apart, from a guest-ratings flush that
-- ran twice on one page load. The client race is fixed separately; this is
-- the part that makes it impossible rather than unlikely.
--
-- NULLS NOT DISTINCT needs Postgres 15+. Railway runs 18.6.
--
-- Prisma cannot express this in schema.prisma, but it also does not notice
-- it: the index keeps its generated name and columns, so `migrate diff`
-- and `migrate status` both stay clean (verified). Duplicates must be
-- cleared before this runs or the index will not build.

DELETE FROM "Review" a
USING "Review" b
WHERE a."seasonNumber" IS NULL
  AND b."seasonNumber" IS NULL
  AND a."userId" = b."userId"
  AND a."mediaItemId" = b."mediaItemId"
  AND a."createdAt" > b."createdAt";

DROP INDEX IF EXISTS "Review_userId_mediaItemId_seasonNumber_key";

CREATE UNIQUE INDEX "Review_userId_mediaItemId_seasonNumber_key"
  ON "Review" ("userId", "mediaItemId", "seasonNumber") NULLS NOT DISTINCT;
