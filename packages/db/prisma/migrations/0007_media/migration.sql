-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING_UPLOAD', 'PROCESSING', 'READY', 'REJECTED');

-- CreateTable
CREATE TABLE "media_asset" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "file_name" TEXT NOT NULL,
    "declared_mime_type" TEXT NOT NULL,
    "declared_size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT,
    "reject_reason" TEXT,
    "alt_text" TEXT,
    "uploaded_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_rendition" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "profile" TEXT NOT NULL,
    "crop_hash" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_rendition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_media" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "crop" JSONB,
    "letterbox" BOOLEAN NOT NULL DEFAULT false,
    "alt_text" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_asset_workspace_id_created_at_idx" ON "media_asset"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "media_rendition_workspace_id_idx" ON "media_rendition"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_rendition_asset_id_profile_crop_hash_key" ON "media_rendition"("asset_id", "profile", "crop_hash");

-- CreateIndex
CREATE INDEX "post_media_variant_id_position_idx" ON "post_media"("variant_id", "position");

-- CreateIndex
CREATE INDEX "post_media_asset_id_idx" ON "post_media"("asset_id");

-- CreateIndex
CREATE INDEX "post_media_workspace_id_idx" ON "post_media"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_media_variant_id_asset_id_key" ON "post_media"("variant_id", "asset_id");

-- AddForeignKey
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_rendition" ADD CONSTRAINT "media_rendition_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_rendition" ADD CONSTRAINT "media_rendition_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "post_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
