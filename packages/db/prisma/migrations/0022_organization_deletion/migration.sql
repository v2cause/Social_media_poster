-- The deletion of an organization (guide step 8.2, architecture 6.2, ADR 0037): an owner deletes
-- it, nobody works in it from then on, and the worker role "gdpr" erases it 30 days later unless an
-- owner takes the deletion back.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);
