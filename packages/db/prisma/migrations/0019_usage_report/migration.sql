-- What the daily usage report has not passed to Stripe yet: the AI usage and the X API costs of
-- an organization since the start of its billing (guide step 7.3, ADR 0035).

-- CreateIndex
CREATE INDEX "api_cost_record_unreported_idx" ON "api_cost_record"("organization_id", "created_at") WHERE (reported_to_stripe_at IS NULL);

-- CreateIndex
CREATE INDEX "usage_record_unreported_idx" ON "usage_record"("organization_id", "created_at") WHERE (reported_to_stripe_at IS NULL);
