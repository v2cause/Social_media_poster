-- The requests of data protection (guide steps 8.1 and 8.2, ADR 0036): the export and the
-- erasure of an organization, which the worker role "gdpr" runs.

-- CreateEnum
CREATE TYPE "GdprRequestKind" AS ENUM ('EXPORT', 'ERASURE');

-- CreateEnum
CREATE TYPE "GdprRequestStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "gdpr_request" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "GdprRequestKind" NOT NULL,
    "status" "GdprRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "object_key" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "gdpr_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gdpr_request_organization_id_created_at_idx" ON "gdpr_request"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "gdpr_request_status_run_after_idx" ON "gdpr_request"("status", "run_after");

-- CreateIndex
CREATE UNIQUE INDEX "gdpr_request_open_key" ON "gdpr_request"("organization_id", "kind") WHERE (status IN ('PENDING', 'RUNNING'));

-- AddForeignKey
ALTER TABLE "gdpr_request" ADD CONSTRAINT "gdpr_request_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

