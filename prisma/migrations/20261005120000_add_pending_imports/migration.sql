-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('LETTERBOXD', 'GOODREADS', 'IMDB');

-- CreateEnum
CREATE TYPE "PendingImportStatus" AS ENUM ('PENDING', 'RESOLVED', 'CONFLICT', 'UNRESOLVABLE', 'DISMISSED');

-- CreateTable
CREATE TABLE "PendingImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "author" TEXT,
    "isbn" TEXT,
    "imdbId" TEXT,
    "externalKey" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "reviewText" TEXT,
    "dateConsumed" TIMESTAMP(3),
    "visibility" "ReviewVisibility" NOT NULL DEFAULT 'PUBLIC',
    "status" "PendingImportStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastTriedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "mediaItemId" TEXT,
    "reviewId" TEXT,
    "conflictRating" INTEGER,
    "conflictReviewText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingImport_status_lastTriedAt_idx" ON "PendingImport"("status", "lastTriedAt");

-- CreateIndex
CREATE INDEX "PendingImport_userId_status_idx" ON "PendingImport"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PendingImport_userId_source_externalKey_key" ON "PendingImport"("userId", "source", "externalKey");

-- AddForeignKey
ALTER TABLE "PendingImport" ADD CONSTRAINT "PendingImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingImport" ADD CONSTRAINT "PendingImport_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

