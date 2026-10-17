-- The analytics tables (guide step 5.1, architecture 6.2 and 8): the snapshots of the post
-- metrics, the latest snapshot per variant, the daily numbers of the accounts and the rollup per
-- account and day. post_variant gets the mark of a post the platform no longer knows.

-- AlterTable
ALTER TABLE "post_variant" ADD COLUMN     "external_deleted_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "metric_snapshot" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "step" INTEGER,
    "impressions" INTEGER,
    "reach" INTEGER,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "clicks" INTEGER,
    "saves" INTEGER,
    "raw" JSONB NOT NULL,
    "mapping_version" INTEGER NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "metric_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_metric_latest" (
    "variant_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "impressions" INTEGER,
    "reach" INTEGER,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "clicks" INTEGER,
    "saves" INTEGER,
    "engagements" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "post_metric_latest_pkey" PRIMARY KEY ("variant_id")
);

-- CreateTable
CREATE TABLE "account_metric_snapshot" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "day" DATE NOT NULL,
    "followers" INTEGER,
    "reach" INTEGER,
    "profile_views" INTEGER,
    "raw" JSONB NOT NULL,
    "mapping_version" INTEGER NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_metric_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_daily" (
    "workspace_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "day" DATE NOT NULL,
    "impressions" INTEGER,
    "post_reach" INTEGER,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "clicks" INTEGER,
    "saves" INTEGER,
    "engagements" INTEGER,
    "posts_published" INTEGER NOT NULL DEFAULT 0,
    "followers" INTEGER,
    "account_reach" INTEGER,
    "profile_views" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "analytics_daily_pkey" PRIMARY KEY ("social_account_id","day")
);

-- CreateIndex
CREATE INDEX "metric_snapshot_variant_id_captured_at_idx" ON "metric_snapshot"("variant_id", "captured_at");

-- CreateIndex
CREATE INDEX "metric_snapshot_workspace_id_captured_at_idx" ON "metric_snapshot"("workspace_id", "captured_at");

-- CreateIndex
CREATE INDEX "post_metric_latest_workspace_id_published_at_idx" ON "post_metric_latest"("workspace_id", "published_at");

-- CreateIndex
CREATE INDEX "account_metric_snapshot_workspace_id_day_idx" ON "account_metric_snapshot"("workspace_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "account_metric_snapshot_social_account_id_day_key" ON "account_metric_snapshot"("social_account_id", "day");

-- CreateIndex
CREATE INDEX "analytics_daily_workspace_id_day_idx" ON "analytics_daily"("workspace_id", "day");

-- AddForeignKey
ALTER TABLE "metric_snapshot" ADD CONSTRAINT "metric_snapshot_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_snapshot" ADD CONSTRAINT "metric_snapshot_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "post_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_snapshot" ADD CONSTRAINT "metric_snapshot_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metric_latest" ADD CONSTRAINT "post_metric_latest_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metric_latest" ADD CONSTRAINT "post_metric_latest_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "post_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metric_latest" ADD CONSTRAINT "post_metric_latest_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_metric_snapshot" ADD CONSTRAINT "account_metric_snapshot_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_metric_snapshot" ADD CONSTRAINT "account_metric_snapshot_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

