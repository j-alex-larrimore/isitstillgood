-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN "normalizedTitle" TEXT;

-- CreateIndex
CREATE INDEX "MediaItem_normalizedTitle_idx" ON "MediaItem"("normalizedTitle");
