-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN     "streamingProviders" JSONB,
ADD COLUMN     "streamingUpdatedAt" TIMESTAMP(3);
