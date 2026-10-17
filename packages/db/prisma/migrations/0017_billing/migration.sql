-- The plans and subscriptions of billing and the report marks of the usage and cost ledgers
-- (guide steps 7.1 to 7.3, architecture 6.2, ADR 0033).

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'INCOMPLETE', 'INCOMPLETE_EXPIRED', 'PAUSED');

-- AlterTable
ALTER TABLE "api_cost_record" ADD COLUMN     "reported_to_stripe_at" TIMESTAMPTZ(3),
ADD COLUMN     "stripe_report_id" TEXT;

-- AlterTable
ALTER TABLE "usage_record" ADD COLUMN     "stripe_report_id" TEXT;

-- CreateTable
CREATE TABLE "plan" (
    "key" TEXT NOT NULL,
    "limits" JSONB NOT NULL,
    "price_lookup_key" TEXT,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_key" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "limit_overrides" JSONB,
    "trial_ends_at" TIMESTAMPTZ(3),
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "current_period_start" TIMESTAMPTZ(3),
    "current_period_end" TIMESTAMPTZ(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "past_due_since" TIMESTAMPTZ(3),
    "read_only_at" TIMESTAMPTZ(3),
    "read_only_notified_at" TIMESTAMPTZ(3),
    "billing_started_at" TIMESTAMPTZ(3),
    "synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_price_lookup_key_key" ON "plan"("price_lookup_key");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_organization_id_key" ON "subscription"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_stripe_customer_id_key" ON "subscription"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_stripe_subscription_id_key" ON "subscription"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscription_read_only_at_idx" ON "subscription"("read_only_at");

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_key_fkey" FOREIGN KEY ("plan_key") REFERENCES "plan"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

