-- CreateTable
CREATE TABLE "VisitLog" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT,
    "medium" TEXT,
    "campaign" TEXT,
    "content" TEXT,
    "clickId" TEXT,
    "clickNetwork" TEXT,
    "referrerHost" TEXT,
    "country" TEXT,
    "device" TEXT,
    "bot" BOOLEAN NOT NULL DEFAULT false,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisitLog_createdAt_idx" ON "VisitLog"("createdAt");

-- CreateIndex
CREATE INDEX "VisitLog_source_idx" ON "VisitLog"("source");

-- CreateIndex
CREATE INDEX "VisitLog_sessionId_idx" ON "VisitLog"("sessionId");

-- CreateIndex
CREATE INDEX "VisitLog_bot_createdAt_idx" ON "VisitLog"("bot", "createdAt");

