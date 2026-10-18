-- The clean-up of the media library (architecture 9, guide step 8.3, ADR 0038): an asset removed
-- from the library goes 30 days later, an upload that never completed after 24 hours. The partial
-- indexes hold only those assets, so the hourly sweep finds them without reading the library.

-- CreateIndex
CREATE INDEX "media_asset_deleted_idx" ON "media_asset"("deleted_at") WHERE (deleted_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "media_asset_pending_idx" ON "media_asset"("created_at") WHERE (status = 'PENDING_UPLOAD');
