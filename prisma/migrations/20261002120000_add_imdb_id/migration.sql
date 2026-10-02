-- The IMDb `tt…` id for movies and TV parent rows, so a ratings CSV a user
-- exported from their own IMDb account can be matched on an exact key rather
-- than by title+year. Identifier only — IMDb *ratings* stay removed for the
-- licensing reasons noted in schema.prisma, and nothing in the app reads from
-- IMDb; the ids come from TMDB's own imdb_id/external_ids fields.
--
-- Additive and nullable: existing rows are unaffected and the column is
-- backfilled separately by scripts/backfill-imdb-ids.js.
--
-- Not unique by design, matching isbn13 — a lookup key, not an identity.
ALTER TABLE "MediaItem" ADD COLUMN     "imdbId" TEXT;

CREATE INDEX "MediaItem_imdbId_idx" ON "MediaItem"("imdbId");
