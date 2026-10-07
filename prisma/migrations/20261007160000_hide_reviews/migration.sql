-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "hiddenFromFeed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hiddenFromProfile" BOOLEAN NOT NULL DEFAULT false;

