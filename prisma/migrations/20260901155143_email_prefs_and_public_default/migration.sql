-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailOnFriendRequest" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "profilePublic" SET DEFAULT true;

