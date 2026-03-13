-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN     "resumeText" TEXT;

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "preferenceId" TEXT,
    "paymentId" TEXT,
    "status" TEXT NOT NULL,
    "raw" JSONB,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentId_key" ON "Payment"("paymentId");

-- CreateIndex
CREATE INDEX "Payment_provider_createdAt_idx" ON "Payment"("provider", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Payment_sessionId_createdAt_idx" ON "Payment"("sessionId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
