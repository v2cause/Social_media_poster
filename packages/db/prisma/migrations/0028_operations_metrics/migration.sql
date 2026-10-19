-- The metrics of guide step 8.7 add up the cost of the AI and the spend on X of the last 24 hours
-- across all tenants; without these indexes every scrape would read both tables in full.

-- CreateIndex
CREATE INDEX "ai_generation_created_idx" ON "ai_generation"("created_at");

-- CreateIndex
CREATE INDEX "api_cost_record_created_idx" ON "api_cost_record"("created_at");
