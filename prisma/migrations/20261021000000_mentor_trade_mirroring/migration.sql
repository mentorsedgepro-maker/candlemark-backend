CREATE TYPE "TradeResult" AS ENUM ('WIN', 'LOSS');

CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "result" "TradeResult" NOT NULL,
    "profitRate" DECIMAL(10,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TradeExecution" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "menteeId" TEXT NOT NULL,
    "allocatedAmount" BIGINT NOT NULL,
    "pnlAmount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MirrorAllocation" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "menteeId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "MirrorAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Trade_mentorId_createdAt_idx" ON "Trade"("mentorId", "createdAt");

CREATE INDEX "TradeExecution_tradeId_idx" ON "TradeExecution"("tradeId");

CREATE INDEX "TradeExecution_menteeId_createdAt_idx" ON "TradeExecution"("menteeId", "createdAt");

CREATE UNIQUE INDEX "MirrorAllocation_mentorId_menteeId_key" ON "MirrorAllocation"("mentorId", "menteeId");

ALTER TABLE "Trade" ADD CONSTRAINT "Trade_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TradeExecution" ADD CONSTRAINT "TradeExecution_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TradeExecution" ADD CONSTRAINT "TradeExecution_menteeId_fkey" FOREIGN KEY ("menteeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MirrorAllocation" ADD CONSTRAINT "MirrorAllocation_menteeId_fkey" FOREIGN KEY ("menteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
