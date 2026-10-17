-- The risk acknowledgements of the X browser (guide step 6.1, architecture 4.3 and 6.2).

-- CreateTable
CREATE TABLE "risk_acknowledgement" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "text_version" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "ip_address" TEXT,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "risk_acknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "risk_acknowledgement_workspace_id_subject_accepted_at_idx" ON "risk_acknowledgement"("workspace_id", "subject", "accepted_at");

-- AddForeignKey
ALTER TABLE "risk_acknowledgement" ADD CONSTRAINT "risk_acknowledgement_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
