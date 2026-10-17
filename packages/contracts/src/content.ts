import { PLATFORMS } from '@smp/platform-rules';
import { z } from 'zod';

import { localeSchema } from './locale';
import { variantMediaSchema } from './media';

// Request and response shapes of the content API (guide step 2.7): posts and their variants,
// styles, brand voices and ideas. The composer and the settings pages use the same schemas.

export const platformSchema = z.enum(PLATFORMS);

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.uuid();
const timestamp = z.iso.datetime();
/** Optimistic locking: the version the client last read (409 when it is stale). */
const version = z.number().int().min(0);

/** The longest brief the AI accepts (architecture 5.3). */
export const BRIEF_MAX_LENGTH = 4000;
/** Enough for the longest platform (Facebook, 63206 characters) with room for emoji. */
export const VARIANT_TEXT_MAX_LENGTH = 100_000;

/** A hashtag without "#": letters, digits, marks and the underscore. */
export const hashtagSchema = z
  .string()
  .trim()
  .transform((tag) => tag.replace(/^#+/, ''))
  .pipe(
    z
      .string()
      .min(1)
      .max(100)
      .regex(/^[\p{L}\p{N}\p{M}_]+$/u, 'invalid_hashtag'),
  );

// --- Variants and posts ---------------------------------------------------------------------

export const VARIANT_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'QUEUED',
  'PUBLISHING',
  'RETRYING',
  'PUBLISHED',
  'FAILED',
  'NEEDS_ATTENTION',
  'CANCELED',
  'DELETED',
] as const;
export const variantStatusSchema = z.enum(VARIANT_STATUSES);

export const variantSchema = z.object({
  id,
  postId: id,
  platform: platformSchema,
  targetKey: z.string(),
  text: z.string(),
  hashtags: z.array(z.string()),
  firstComment: z.string().nullable(),
  linkUrl: z.string().nullable(),
  aiWarnings: z.array(z.string()),
  status: variantStatusSchema,
  /** The attached media in their order, with signed thumbnails. */
  media: z.array(variantMediaSchema),
  /** The account the variant goes out to. */
  socialAccountId: id.nullable(),
  /** When it goes out, or went out for "Jetzt posten"; shown in scheduledTimezone. */
  scheduledAt: timestamp.nullable(),
  scheduledTimezone: z.string().nullable(),
  publishedAt: timestamp.nullable(),
  /** The post on the platform. */
  externalUrl: z.string().nullable(),
  /** Why the last attempt failed, for example MISSED_WINDOW or REAUTH_REQUIRED. */
  failureCode: z.string().nullable(),
  /** Published in a dry run: nothing went out. */
  isDryRun: z.boolean(),
  version,
  updatedAt: timestamp,
});
export type VariantDto = z.infer<typeof variantSchema>;

export const postSchema = z.object({
  id,
  brief: z.string(),
  language: localeSchema,
  styleId: id.nullable(),
  brandVoiceId: id.nullable(),
  ideaId: id.nullable(),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
  variants: z.array(variantSchema),
});
export type PostDto = z.infer<typeof postSchema>;

const platformsSchema = z
  .array(platformSchema)
  .min(1)
  .max(PLATFORMS.length)
  .refine((platforms) => new Set(platforms).size === platforms.length, { message: 'duplicate_platform' });

export const createPostSchema = z.object({
  brief: z.string().trim().max(BRIEF_MAX_LENGTH).default(''),
  language: localeSchema,
  styleId: id.nullable().default(null),
  brandVoiceId: id.nullable().default(null),
  ideaId: id.nullable().default(null),
  /** One variant per platform, in this order (targets t1, t2, ...). */
  platforms: platformsSchema,
});
export type CreatePostRequest = z.input<typeof createPostSchema>;

export const updatePostSchema = z
  .object({
    version,
    brief: z.string().trim().max(BRIEF_MAX_LENGTH).optional(),
    language: localeSchema.optional(),
    styleId: id.nullable().optional(),
    brandVoiceId: id.nullable().optional(),
    /** Adds variants for new platforms and removes the drafts of dropped ones. */
    platforms: platformsSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 1, { message: 'empty_patch' });
export type UpdatePostRequest = z.input<typeof updatePostSchema>;

export const updateVariantSchema = z
  .object({
    version,
    text: z.string().max(VARIANT_TEXT_MAX_LENGTH).optional(),
    hashtags: z.array(hashtagSchema).max(30).optional(),
    firstComment: z.string().max(8000).nullable().optional(),
    linkUrl: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .nullable()
      .optional(),
    /** The warnings of the AI that still apply; the editor drops the ones the user resolved. */
    aiWarnings: z.array(z.string().max(500)).max(20).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 1, { message: 'empty_patch' });
export type UpdateVariantRequest = z.input<typeof updateVariantSchema>;

export const postSummarySchema = z.object({
  id,
  brief: z.string(),
  language: localeSchema,
  styleId: id.nullable(),
  updatedAt: timestamp,
  variants: z.array(
    z.object({ id, platform: platformSchema, status: variantStatusSchema, excerpt: z.string() }),
  ),
});
export const postPageSchema = z.object({
  posts: z.array(postSummarySchema),
  nextCursor: z.string().nullable(),
});
export type PostPage = z.infer<typeof postPageSchema>;

export const postListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// --- Styles -----------------------------------------------------------------------------------

export const styleSchema = z.object({
  id,
  /** Presets: their fixed key; custom styles: "custom-" plus a slug of the name. */
  key: z.string(),
  name: z.string(),
  instructions: z.string(),
  isPreset: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  version,
});
export type StyleDto = z.infer<typeof styleSchema>;
export const styleListSchema = z.object({ styles: z.array(styleSchema) });

export const createStyleSchema = z.object({
  name: text(60),
  instructions: text(2000),
});
export type CreateStyleRequest = z.input<typeof createStyleSchema>;

export const updateStyleSchema = z
  .object({
    version,
    name: text(60).optional(),
    instructions: text(2000).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 1, { message: 'empty_patch' });
export type UpdateStyleRequest = z.input<typeof updateStyleSchema>;

// --- Brand voices -----------------------------------------------------------------------------

export const EMOJI_POLICIES = ['none', 'sparse', 'normal'] as const;
export const HASHTAG_POLICIES = ['none', 'few', 'normal'] as const;

const items = (max: number, length: number) => z.array(text(length)).max(max).default([]);

/** The content of a brand voice version (architecture 5.2, layer 2). */
export const brandVoiceContentSchema = z.object({
  name: text(80),
  description: z.string().trim().max(1000).default(''),
  tone: items(10, 40),
  dos: items(20, 200),
  donts: items(20, 200),
  vocabulary: items(50, 60),
  forbiddenWords: items(100, 60),
  emojiPolicy: z.enum(EMOJI_POLICIES).default('sparse'),
  hashtagPolicy: z.enum(HASHTAG_POLICIES).default('few'),
  /** Three to five example posts are recommended. */
  examplePosts: items(5, 3000),
  language: localeSchema,
});
export type BrandVoiceContent = z.infer<typeof brandVoiceContentSchema>;
export type BrandVoiceContentInput = z.input<typeof brandVoiceContentSchema>;

export const brandVoiceSchema = z.object({
  id,
  name: z.string(),
  isDefault: z.boolean(),
  archived: z.boolean(),
  currentVersionNumber: z.number().int(),
  content: brandVoiceContentSchema,
  version,
  updatedAt: timestamp,
});
export type BrandVoiceDto = z.infer<typeof brandVoiceSchema>;
export const brandVoiceListSchema = z.object({ brandVoices: z.array(brandVoiceSchema) });

export const createBrandVoiceSchema = z.object({
  content: brandVoiceContentSchema,
  isDefault: z.boolean().default(false),
});
export type CreateBrandVoiceRequest = z.input<typeof createBrandVoiceSchema>;

export const updateBrandVoiceSchema = z
  .object({
    version,
    /** A change of the content creates a new immutable version. */
    content: brandVoiceContentSchema.optional(),
    isDefault: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 1, { message: 'empty_patch' });
export type UpdateBrandVoiceRequest = z.input<typeof updateBrandVoiceSchema>;

export const brandVoiceVersionSchema = z.object({
  versionNumber: z.number().int(),
  content: brandVoiceContentSchema,
  createdAt: timestamp,
});
export const brandVoiceVersionListSchema = z.object({ versions: z.array(brandVoiceVersionSchema) });

// --- Ideas ------------------------------------------------------------------------------------

export const IDEA_STATUSES = ['NEW', 'SAVED', 'DISCARDED', 'USED'] as const;
export const ideaStatusSchema = z.enum(IDEA_STATUSES);

export const ideaSchema = z.object({
  id,
  title: z.string(),
  angle: z.string().nullable(),
  pillar: z.string().nullable(),
  whyNow: z.string().nullable(),
  /** What inspired the idea in words, for example a content pillar. */
  basedOn: z.array(z.string()),
  /** The published posts the idea builds on (guide step 5.6); a deleted post leaves the list. */
  basedOnPosts: z.array(
    z.object({ variantId: id, postId: id, platform: platformSchema, preview: z.string() }),
  ),
  suggestedPlatforms: z.array(platformSchema),
  suggestedStyleKey: z.string().nullable(),
  format: z.string().nullable(),
  status: ideaStatusSchema,
  source: z.enum(['AI', 'MANUAL']),
  version,
  createdAt: timestamp,
});
export type IdeaDto = z.infer<typeof ideaSchema>;
export const ideaListSchema = z.object({ ideas: z.array(ideaSchema) });

export const ideaListQuerySchema = z.object({ status: ideaStatusSchema.optional() });

export const generateIdeasSchema = z.object({ count: z.number().int().min(1).max(10).default(10) });
export const generateIdeasResponseSchema = z.object({
  ideas: z.array(ideaSchema),
  /** Suggestions left out because they resembled existing ideas. */
  duplicates: z.number().int(),
});

export const updateIdeaSchema = z
  .object({
    version,
    status: ideaStatusSchema.optional(),
    title: text(200).optional(),
    angle: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 1, { message: 'empty_patch' });
export type UpdateIdeaRequest = z.input<typeof updateIdeaSchema>;
