-- CreateTable
CREATE TABLE "ImportEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportEvent_userId_idx" ON "ImportEvent"("userId");

-- CreateIndex
CREATE INDEX "ImportEvent_createdAt_idx" ON "ImportEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "ImportEvent" ADD CONSTRAINT "ImportEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

