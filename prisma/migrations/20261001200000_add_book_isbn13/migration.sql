-- ISBN-13 for books, so a Goodreads export can be matched exactly rather than
-- by title+author. Additive and nullable: existing rows are unaffected and the
-- column is backfilled separately by scripts/backfill-isbns.js.
--
-- Not unique by design — editions and series parents legitimately repeat an
-- ISBN, so this is a lookup key rather than an identity.
ALTER TABLE "MediaItem" ADD COLUMN     "isbn13" TEXT;

CREATE INDEX "MediaItem_isbn13_idx" ON "MediaItem"("isbn13");
