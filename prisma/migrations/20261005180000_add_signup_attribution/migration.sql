-- AlterTable
ALTER TABLE "User" ADD COLUMN     "attrCampaign" TEXT,
ADD COLUMN     "attrCapturedAt" TIMESTAMP(3),
ADD COLUMN     "attrContent" TEXT,
ADD COLUMN     "attrLandedAt" TIMESTAMP(3),
ADD COLUMN     "attrLandedOn" TEXT,
ADD COLUMN     "attrMedium" TEXT,
ADD COLUMN     "attrMetaClickId" TEXT,
ADD COLUMN     "attrRedditClickId" TEXT,
ADD COLUMN     "attrReferrer" TEXT,
ADD COLUMN     "attrSource" TEXT,
ADD COLUMN     "attrTerm" TEXT;

-- CreateIndex
CREATE INDEX "User_attrSource_idx" ON "User"("attrSource");

-- CreateIndex
CREATE INDEX "User_attrCampaign_idx" ON "User"("attrCampaign");

