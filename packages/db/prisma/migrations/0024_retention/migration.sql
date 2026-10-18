-- The retention periods (guide step 8.3, ADR 0038). After 180 days the raw data of an AI
-- generation is cleared, while its counts and costs stay for billing. The partial indexes find the
-- rows the nightly run still has to change: generations with raw data, entries of the audit log
-- with connection data and processed webhook events. The index on the end of a session finds the
-- expired ones.

-- AlterTable
ALTER TABLE "ai_generation" ALTER COLUMN "input" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "audit_log_connection_data_idx" ON "audit_log"("created_at") WHERE (ip_address IS NOT NULL OR user_agent IS NOT NULL);

-- CreateIndex
CREATE INDEX "ai_generation_raw_data_idx" ON "ai_generation"("created_at") WHERE (input IS NOT NULL OR output IS NOT NULL);

-- CreateIndex
CREATE INDEX "webhook_event_processed_idx" ON "webhook_event"("processed_at") WHERE (processed_at IS NOT NULL);
