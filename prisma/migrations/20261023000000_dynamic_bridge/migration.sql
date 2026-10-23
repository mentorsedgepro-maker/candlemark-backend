CREATE TYPE "BridgeAsset" AS ENUM ('EVM', 'SOLANA');

CREATE TABLE "BridgeOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "assetType" "BridgeAsset" NOT NULL,
    "depositAddress" TEXT NOT NULL,
    "refundAddress" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING_DEPOSIT',
    "depositSeenBlock" INTEGER,
    "sourceTxHash" TEXT,
    "sourceAmountAtomic" BIGINT,
    "moneroAccountIndex" INTEGER,
    "moneroAmountAtomic" BIGINT,
    "sideShiftId" TEXT,
    "sideShiftDeposit" TEXT,
    "changeNowId" TEXT,
    "changeNowPayinAddress" TEXT,
    "moneroTxHash" TEXT,
    "payoutTxHash" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BridgeOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BridgeOrder_idempotencyKey_key" ON "BridgeOrder"("idempotencyKey");
CREATE UNIQUE INDEX "BridgeOrder_depositAddress_key" ON "BridgeOrder"("depositAddress");
CREATE INDEX "BridgeOrder_userId_createdAt_idx" ON "BridgeOrder"("userId", "createdAt");
CREATE INDEX "BridgeOrder_status_updatedAt_idx" ON "BridgeOrder"("status", "updatedAt");

ALTER TABLE "BridgeOrder" ADD CONSTRAINT "BridgeOrder_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
