import { VALIDATION_ISSUE_CODES } from '@smp/platform-rules';
import { z } from 'zod';

import { BRIEF_MAX_LENGTH, hashtagSchema, platformSchema, VARIANT_TEXT_MAX_LENGTH } from './content';
import { localeSchema } from './locale';

// Requests and server-sent events of the AI endpoints (guide step 2.7, architecture 5.3).
// Generation and refinement stream the same events; each SSE message carries the event name in
// "event:" and the whole event, type included, as JSON in "data:".

export const REFINE_ACTIONS = [
  'shorter',
  'longer',
  'more_formal',
  'more_casual',
  'stronger_hook',
  'add_cta',
  'fewer_emojis',
  'translate',
  'rewrite_for_platform',
  'custom',
] as const;
export const refineActionSchema = z.enum(REFINE_ACTIONS);
export type RefineActionDto = z.infer<typeof refineActionSchema>;

export const generateVariantsSchema = z.object({
  postId: z.uuid(),
  /** Only these variants of the post; all when missing. */
  variantIds: z.array(z.uuid()).min(1).max(4).optional(),
});
export type GenerateVariantsRequest = z.input<typeof generateVariantsSchema>;

export const refineVariantSchema = z
  .object({
    variantId: z.uuid(),
    action: refineActionSchema,
    /** The request of action "custom". */
    instruction: z.string().trim().min(1).max(500).optional(),
    /** The target language of action "translate". */
    language: localeSchema.optional(),
    /** The variant as the editor shows it, saved or not. */
    current: z.object({
      text: z.string().max(VARIANT_TEXT_MAX_LENGTH),
      hashtags: z.array(hashtagSchema).max(30),
      firstComment: z.string().max(8000).nullable(),
    }),
  })
  .refine((request) => request.action !== 'custom' || request.instruction !== undefined, {
    message: 'instruction_required',
    path: ['instruction'],
  })
  .refine((request) => request.action !== 'translate' || request.language !== undefined, {
    message: 'language_required',
    path: ['language'],
  });
export type RefineVariantRequest = z.input<typeof refineVariantSchema>;

export const testBrandVoiceSchema = z.object({
  /** What the sample post is about; a general topic when missing. */
  brief: z.string().trim().max(BRIEF_MAX_LENGTH).optional(),
});

/** The count as the platform counts, computed on the server with @smp/platform-rules. */
export const textCountSchema = z.object({
  length: z.number().int(),
  max: z.number().int(),
  overLimit: z.boolean(),
  recommendedLength: z.number().int().optional(),
});

export const validationIssueSchema = z.object({
  code: z.enum(VALIDATION_ISSUE_CODES),
  limit: z.number().int().optional(),
  actual: z.number().int().optional(),
  mediaIndex: z.number().int().optional(),
});

export const generatedVariantSchema = z.object({
  /** The variant of the post the text is for. */
  variantId: z.uuid(),
  targetKey: z.string(),
  platform: platformSchema,
  hook: z.string(),
  text: z.string(),
  hashtags: z.array(z.string()),
  firstComment: z.string().nullable(),
  callToAction: z.string().nullable(),
  altTexts: z.array(z.string()),
  warnings: z.array(z.string()),
  count: textCountSchema,
  issues: z.array(validationIssueSchema),
  /** The first answer was over the limit and was shortened once automatically. */
  autoShortened: z.boolean(),
});
export type GeneratedVariantDto = z.infer<typeof generatedVariantSchema>;

/** A variant while it streams in; every field can still be missing or incomplete. */
export const partialVariantSchema = z.object({
  targetKey: z.string().optional(),
  platform: platformSchema.optional(),
  hook: z.string().optional(),
  text: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  firstComment: z.string().nullable().optional(),
  callToAction: z.string().nullable().optional(),
  altTexts: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});
export type PartialVariantDto = z.infer<typeof partialVariantSchema>;

/** Failures of a running generation. QUOTA_EXCEEDED comes as HTTP 402 before the stream. */
export const GENERATION_FAILURE_CODES = [
  'REFUSED',
  'TRUNCATED',
  'INVALID_OUTPUT',
  'PROVIDER_ERROR',
  'CANCELED',
] as const;

export const generationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('generation.started'), generationId: z.uuid() }),
  z.object({ type: z.literal('variant.partial'), variants: z.array(partialVariantSchema) }),
  /** The provider starts over (retry after max_tokens): drop the partial output. */
  z.object({ type: z.literal('variant.reset') }),
  z.object({
    type: z.literal('generation.completed'),
    generationId: z.uuid(),
    variants: z.array(generatedVariantSchema),
  }),
  z.object({
    type: z.literal('generation.failed'),
    generationId: z.uuid(),
    code: z.enum(GENERATION_FAILURE_CODES),
    retryable: z.boolean(),
  }),
]);
export type GenerationEvent = z.infer<typeof generationEventSchema>;
export type GenerationEventType = GenerationEvent['type'];

export const brandVoiceTestResponseSchema = z.object({
  generationId: z.uuid(),
  variant: generatedVariantSchema.omit({ variantId: true }),
});
