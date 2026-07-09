-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "MediaItem_verified_idx" ON "MediaItem"("verified");
