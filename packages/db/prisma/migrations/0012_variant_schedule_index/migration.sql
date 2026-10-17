-- The calendar and the dashboard ask for the variants of a workspace in a period of their plan
-- (guide step 4.11). The index on the workspace alone is covered by the new one.

-- DropIndex
DROP INDEX "post_variant_workspace_id_idx";

-- CreateIndex
CREATE INDEX "post_variant_workspace_id_scheduled_at_idx" ON "post_variant"("workspace_id", "scheduled_at");
