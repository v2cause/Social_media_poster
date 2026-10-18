-- Owners can require a second factor of every member of their organization (architecture 10,
-- guide step 8.4, ADR 0039). A constant default adds the column without rewriting the table.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN "require_two_factor" BOOLEAN NOT NULL DEFAULT false;
