-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN     "castOrder" TEXT[] DEFAULT ARRAY[]::TEXT[];
