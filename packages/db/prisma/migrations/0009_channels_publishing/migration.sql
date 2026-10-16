-- CreateEnum
CREATE TYPE "ConnectionMethod" AS ENUM ('API', 'BROWSER', 'MOCK');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'EXPIRING', 'NEEDS_REAUTH', 'PAUSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SocialAccountType" AS ENUM ('PROFILE', 'PAGE', 'BUSINESS');

-- CreateEnum
CREATE TYPE "PublishAttemptOutcome" AS ENUM ('STARTED', 'PUBLISHED', 'RECONCILED', 'DRY_RUN', 'RETRY', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "social_connection" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "method" "ConnectionMethod" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_reason" TEXT,
    "external_user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "access_token_sealed" BYTEA,
    "refresh_token_sealed" BYTEA,
    "session_sealed" BYTEA,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiry_notice_days" INTEGER,
    "last_refreshed_at" TIMESTAMPTZ(3),
    "connected_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_account" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "type" "SocialAccountType" NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT,
    "avatar_url" TEXT,
    "access_token_sealed" BYTEA,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "disconnected_at" TIMESTAMPTZ(3),
    "connected_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempt" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "schedule_version" INTEGER NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" "PublishAttemptOutcome" NOT NULL DEFAULT 'STARTED',
    "lease_owner" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "external_post_id" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "publish_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_cost_record" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID,
    "social_account_id" UUID,
    "platform" "Platform" NOT NULL,
    "operation" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 1,
    "cost_micros" BIGINT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_cost_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_connection_expiry_idx" ON "social_connection"("access_token_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "social_connection_workspace_id_platform_method_external_use_key" ON "social_connection"("workspace_id", "platform", "method", "external_user_id");

-- CreateIndex
CREATE INDEX "social_account_connection_id_idx" ON "social_account"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_account_workspace_id_platform_external_id_key" ON "social_account"("workspace_id", "platform", "external_id");

-- CreateIndex
CREATE INDEX "publish_attempt_workspace_id_idx" ON "publish_attempt"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempt_variant_id_schedule_version_attempt_number_key" ON "publish_attempt"("variant_id", "schedule_version", "attempt_number");

-- CreateIndex
CREATE INDEX "outbox_event_pending_idx" ON "outbox_event"("available_at") WHERE (processed_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_event_workspace_id_idx" ON "outbox_event"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_provider_external_id_key" ON "webhook_event"("provider", "external_id");

-- CreateIndex
CREATE INDEX "api_cost_record_organization_id_created_at_idx" ON "api_cost_record"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "api_cost_record_workspace_id_created_at_idx" ON "api_cost_record"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_cost_record_source_type_source_id_operation_key" ON "api_cost_record"("source_type", "source_id", "operation");

-- CreateIndex
CREATE INDEX "post_variant_social_account_id_idx" ON "post_variant"("social_account_id");

-- CreateIndex
CREATE INDEX "post_variant_queued_idx" ON "post_variant"("queued_at") WHERE (status = 'QUEUED');

-- CreateIndex
CREATE INDEX "post_variant_lease_idx" ON "post_variant"("lease_until") WHERE (status = 'PUBLISHING');

-- AddForeignKey
ALTER TABLE "post_variant" ADD CONSTRAINT "post_variant_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_connection" ADD CONSTRAINT "social_connection_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_account" ADD CONSTRAINT "social_account_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_account" ADD CONSTRAINT "social_account_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "social_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempt" ADD CONSTRAINT "publish_attempt_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempt" ADD CONSTRAINT "publish_attempt_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "post_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_cost_record" ADD CONSTRAINT "api_cost_record_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_cost_record" ADD CONSTRAINT "api_cost_record_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_cost_record" ADD CONSTRAINT "api_cost_record_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
