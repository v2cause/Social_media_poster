-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('LINKEDIN', 'INSTAGRAM', 'FACEBOOK', 'X');

-- CreateEnum
CREATE TYPE "IdeaStatus" AS ENUM ('NEW', 'SAVED', 'DISCARDED', 'USED');

-- CreateEnum
CREATE TYPE "IdeaSource" AS ENUM ('AI', 'MANUAL');

-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'RETRYING', 'PUBLISHED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELED', 'DELETED');

-- CreateEnum
CREATE TYPE "AiTask" AS ENUM ('GENERATE', 'REFINE', 'IDEAS', 'ALT_TEXT', 'VOICE_TEST');

-- CreateEnum
CREATE TYPE "AiOutcome" AS ENUM ('OK', 'REFUSED', 'TRUNCATED', 'INVALID_OUTPUT', 'PROVIDER_ERROR', 'CANCELED');

-- CreateTable
CREATE TABLE "post_style" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "post_style_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_voice" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "current_version_number" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "brand_voice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_voice_version" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "brand_voice_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_voice_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "angle" TEXT,
    "pillar" TEXT,
    "why_now" TEXT,
    "based_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "suggested_platforms" "Platform"[] DEFAULT ARRAY[]::"Platform"[],
    "suggested_style_key" TEXT,
    "format" TEXT,
    "status" "IdeaStatus" NOT NULL DEFAULT 'NEW',
    "source" "IdeaSource" NOT NULL DEFAULT 'MANUAL',
    "ai_generation_id" UUID,
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "brief" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL,
    "style_id" UUID,
    "brand_voice_id" UUID,
    "idea_id" UUID,
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_variant" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "social_account_id" UUID,
    "platform" "Platform" NOT NULL,
    "target_key" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "first_comment" TEXT,
    "link_url" TEXT,
    "ai_warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "VariantStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMPTZ(3),
    "scheduled_timezone" TEXT,
    "schedule_version" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "queued_at" TIMESTAMPTZ(3),
    "lease_owner" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "external_post_id" TEXT,
    "external_url" TEXT,
    "failure_code" TEXT,
    "last_error" TEXT,
    "is_dry_run" BOOLEAN NOT NULL DEFAULT false,
    "content_hash" TEXT,
    "metrics_next_at" TIMESTAMPTZ(3),
    "metrics_step" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "post_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_generation" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "task" "AiTask" NOT NULL,
    "post_id" UUID,
    "brand_voice_version_id" UUID,
    "prompt_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_requested" TEXT NOT NULL,
    "model_served" TEXT,
    "effort" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "outcome" "AiOutcome" NOT NULL,
    "stop_reason" TEXT,
    "refusal_category" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "ttft_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counter" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "meter" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "usage_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_record" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID,
    "meter" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "quantity" BIGINT NOT NULL,
    "period_start" DATE NOT NULL,
    "reported_to_stripe_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_book" (
    "id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "input_micros_per_mtok" BIGINT NOT NULL,
    "output_micros_per_mtok" BIGINT NOT NULL,
    "cache_read_micros_per_mtok" BIGINT NOT NULL,
    "cache_write_5m_micros_per_mtok" BIGINT NOT NULL,
    "cache_write_1h_micros_per_mtok" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "checked_at" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_book_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "post_style_workspace_id_key_key" ON "post_style"("workspace_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "post_style_preset_key_key" ON "post_style"("key") WHERE (workspace_id IS NULL);

-- CreateIndex
CREATE INDEX "brand_voice_workspace_id_idx" ON "brand_voice"("workspace_id");

-- CreateIndex
CREATE INDEX "brand_voice_version_workspace_id_idx" ON "brand_voice_version"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_voice_version_brand_voice_id_version_number_key" ON "brand_voice_version"("brand_voice_id", "version_number");

-- CreateIndex
CREATE INDEX "idea_workspace_id_status_created_at_idx" ON "idea"("workspace_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idea_title_trgm_idx" ON "idea" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "post_workspace_id_updated_at_idx" ON "post"("workspace_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "post_variant_workspace_id_idx" ON "post_variant"("workspace_id");

-- CreateIndex
CREATE INDEX "post_variant_due_idx" ON "post_variant"("scheduled_at") WHERE (status = 'SCHEDULED');

-- CreateIndex
CREATE INDEX "post_variant_metrics_due_idx" ON "post_variant"("metrics_next_at") WHERE (status = 'PUBLISHED');

-- CreateIndex
CREATE UNIQUE INDEX "post_variant_post_id_target_key_key" ON "post_variant"("post_id", "target_key");

-- CreateIndex
CREATE INDEX "ai_generation_workspace_id_created_at_idx" ON "ai_generation"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "usage_counter_organization_id_meter_period_start_key" ON "usage_counter"("organization_id", "meter", "period_start");

-- CreateIndex
CREATE INDEX "usage_record_organization_id_period_start_idx" ON "usage_record"("organization_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "usage_record_source_type_source_id_meter_key" ON "usage_record"("source_type", "source_id", "meter");

-- CreateIndex
CREATE UNIQUE INDEX "price_book_model_valid_from_key" ON "price_book"("model", "valid_from");

-- AddForeignKey
ALTER TABLE "post_style" ADD CONSTRAINT "post_style_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_voice" ADD CONSTRAINT "brand_voice_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_voice_version" ADD CONSTRAINT "brand_voice_version_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_voice_version" ADD CONSTRAINT "brand_voice_version_brand_voice_id_fkey" FOREIGN KEY ("brand_voice_id") REFERENCES "brand_voice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea" ADD CONSTRAINT "idea_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea" ADD CONSTRAINT "idea_ai_generation_id_fkey" FOREIGN KEY ("ai_generation_id") REFERENCES "ai_generation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_style_id_fkey" FOREIGN KEY ("style_id") REFERENCES "post_style"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_brand_voice_id_fkey" FOREIGN KEY ("brand_voice_id") REFERENCES "brand_voice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "idea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_variant" ADD CONSTRAINT "post_variant_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_variant" ADD CONSTRAINT "post_variant_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_brand_voice_version_id_fkey" FOREIGN KEY ("brand_voice_version_id") REFERENCES "brand_voice_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_counter" ADD CONSTRAINT "usage_counter_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
