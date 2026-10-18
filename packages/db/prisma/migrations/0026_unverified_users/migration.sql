-- Accounts whose address was never verified go a day after the sign-up (guide step 8.4,
-- ADR 0039), so that nobody holds an address by signing up with it. The partial index holds only
-- those accounts, so the nightly retention run finds them without reading every user.

-- CreateIndex
CREATE INDEX "users_unverified_idx" ON "users"("created_at") WHERE (email_verified = false);
