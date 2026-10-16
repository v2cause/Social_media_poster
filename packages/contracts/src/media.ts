import { z } from 'zod';

// Requests and responses of the media API (guide step 3.3, architecture 9). The library, the
// upload list and the composer use the same schemas. The server checks type and size again and
// never trusts what the browser announces.

const id = z.uuid();
const timestamp = z.iso.datetime();
/** Optimistic locking: the version the client last read (409 when it is stale). */
const version = z.number().int().min(0);

/** JPEG, PNG, WebP and static GIF; no SVG, it can carry scripts. */
export const MEDIA_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const MEDIA_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Enough for every platform; X allows the fewest characters with 1000. */
export const ALT_TEXT_MAX_LENGTH = 1000;

export const MEDIA_STATUSES = ['PENDING_UPLOAD', 'PROCESSING', 'READY', 'REJECTED'] as const;
export const mediaStatusSchema = z.enum(MEDIA_STATUSES);
export type MediaStatusDto = z.infer<typeof mediaStatusSchema>;

/** Why the pipeline refused a file. The UI translates the code. */
export const MEDIA_REJECT_REASONS = [
  'SIZE_MISMATCH',
  'TYPE_MISMATCH',
  'NOT_AN_IMAGE',
  'UNSUPPORTED_FORMAT',
  'HEIC_NOT_SUPPORTED',
  'ANIMATED_NOT_SUPPORTED',
  'DIMENSIONS_TOO_LARGE',
  'CORRUPT_IMAGE',
] as const;
export const mediaRejectReasonSchema = z.enum(MEDIA_REJECT_REASONS);
export type MediaRejectReasonDto = z.infer<typeof mediaRejectReasonSchema>;

/** A WebP thumbnail behind a signed URL that works for one hour. */
export const mediaThumbnailSchema = z.object({
  width: z.number().int(),
  height: z.number().int(),
  url: z.url(),
});

export const mediaAssetSchema = z.object({
  id,
  status: mediaStatusSchema,
  /** The name of the user's file, for display only. */
  fileName: z.string(),
  /** The measured type and size; null until the file arrived. */
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  rejectReason: mediaRejectReasonSchema.nullable(),
  altText: z.string().nullable(),
  /** How many variants show the asset; an asset in use cannot be deleted. */
  usageCount: z.number().int(),
  /** Ordered by width; empty until the asset is ready. The original is never served. */
  thumbnails: z.array(mediaThumbnailSchema),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type MediaAssetDto = z.infer<typeof mediaAssetSchema>;

export const requestUploadSchema = z.object({
  fileName: z.string().max(1024),
  /** As the browser reports it; the API answers MEDIA_TYPE_NOT_ALLOWED for other types. */
  mimeType: z.string().max(255),
  /** In bytes; the API answers MEDIA_TOO_LARGE above the limit. */
  size: z.number().int().min(1),
});
export type RequestUploadRequest = z.input<typeof requestUploadSchema>;

/** The asset waiting for its file and where the browser uploads it, for five minutes. */
export const uploadTicketSchema = z.object({
  asset: mediaAssetSchema,
  upload: z.object({
    url: z.url(),
    method: z.literal('PUT'),
    /** Headers the upload must send exactly; the content type is part of the signature. */
    headers: z.record(z.string(), z.string()),
  }),
  expiresAt: timestamp,
});
export type UploadTicketDto = z.infer<typeof uploadTicketSchema>;

export const MEDIA_USAGE_FILTERS = ['used', 'unused'] as const;

export const mediaListQuerySchema = z.object({
  /** Without a status the library shows every asset whose file arrived. */
  status: mediaStatusSchema.optional(),
  usage: z.enum(MEDIA_USAGE_FILTERS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type MediaListQuery = z.input<typeof mediaListQuerySchema>;

export const mediaPageSchema = z.object({
  assets: z.array(mediaAssetSchema),
  nextCursor: z.string().nullable(),
});
export type MediaPageDto = z.infer<typeof mediaPageSchema>;

export const updateMediaSchema = z.object({
  version,
  /** An empty text removes the alt text. */
  altText: z.string().max(ALT_TEXT_MAX_LENGTH).nullable(),
});
export type UpdateMediaRequest = z.input<typeof updateMediaSchema>;

// --- Media of a variant -------------------------------------------------------------------------

/** The most media one variant holds; LinkedIn takes the most with 20 images. */
export const MAX_VARIANT_MEDIA = 20;

/** A region in pixels of the image as it is shown, after its EXIF orientation. */
export const cropSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type CropDto = z.infer<typeof cropSchema>;

/** An asset in a variant: its place, crop, letterbox and alt text for this use. */
export const variantMediaSchema = z.object({
  id,
  assetId: id,
  position: z.number().int(),
  crop: cropSchema.nullable(),
  /** White bars instead of a crop where the image does not fit the aspect ratio of the platform. */
  letterbox: z.boolean(),
  /** The alt text of this use; null takes the one of the asset. */
  altText: z.string().nullable(),
  asset: mediaAssetSchema,
});
export type VariantMediaDto = z.infer<typeof variantMediaSchema>;

export const setVariantMediaSchema = z.object({
  /** The version of the variant the client last read (409 when it is stale). */
  version,
  /** All media of the variant in their order; an empty list removes them. */
  items: z
    .array(
      z.object({
        assetId: id,
        crop: cropSchema.nullable().default(null),
        letterbox: z.boolean().default(false),
        altText: z.string().max(ALT_TEXT_MAX_LENGTH).nullable().default(null),
      }),
    )
    .max(MAX_VARIANT_MEDIA)
    .refine((items) => new Set(items.map((item) => item.assetId)).size === items.length, {
      message: 'duplicate_media',
    }),
});
export type SetVariantMediaRequest = z.input<typeof setVariantMediaSchema>;
