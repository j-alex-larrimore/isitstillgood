-- Group reviews saved in one action so the feed shows them once.
-- Additive and backward-compatible: both columns are nullable or defaulted,
-- existing rows become batchId NULL / isBatchLead false, which is exactly
-- "an ordinary standalone review" and is how the feed already treats them.

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "isBatchLead" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Review_batchId_idx" ON "Review"("batchId");
