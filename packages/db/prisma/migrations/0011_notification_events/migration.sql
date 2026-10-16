-- In-app notifications of events (guide step 4.9): each one names the outbox event it came
-- from, so a job that runs again after a failure adds no second notification for the same user.

-- AlterTable
ALTER TABLE "notification" ADD COLUMN "event_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "notification_user_id_event_id_key" ON "notification"("user_id", "event_id");
