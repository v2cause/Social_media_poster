import type { GeneratedVariant, TopicIdea } from '@smp/core';
import { PLATFORMS } from '@smp/platform-rules';
import { z } from 'zod';

// Structured outputs of the model (architecture 5.3), passed as output_config.format. Every
// object is strict (additionalProperties: false, which the API requires). Limits such as text
// lengths are not part of the schema: the API supports no length constraints, and the server
// counts characters itself with @smp/platform-rules.

const platform = z.enum(PLATFORMS);

export const generatedVariantSchema = z.strictObject({
  targetKey: z.string().describe('The key of the target, for example t1.'),
  platform,
  hook: z.string().describe('The opening sentence of text, copied from it.'),
  text: z.string().describe('The complete post as it will be published, without the hashtags.'),
  hashtags: z.array(z.string()).describe('Hashtags without "#".'),
  firstComment: z.string().nullable(),
  callToAction: z.string().nullable().describe('The call to action as it appears in text, or null.'),
  altTexts: z.array(z.string()).describe('One description per described media item, in order.'),
  warnings: z.array(z.string()).describe('Short notes for the editor, in the language of the task.'),
}) satisfies z.ZodType<GeneratedVariant>;

export const variantsOutputSchema = z.strictObject({
  variants: z.array(generatedVariantSchema),
});
export type VariantsOutput = z.infer<typeof variantsOutputSchema>;

export const topicIdeaSchema = z.strictObject({
  title: z.string(),
  angle: z.string(),
  pillar: z.string().nullable(),
  whyNow: z.string(),
  basedOn: z.array(z.string()),
  suggestedPlatforms: z.array(platform),
  suggestedStyleKey: z.string().nullable(),
  format: z.string(),
}) satisfies z.ZodType<TopicIdea>;

export const topicIdeasOutputSchema = z.strictObject({
  ideas: z.array(topicIdeaSchema),
});
export type TopicIdeasOutput = z.infer<typeof topicIdeasOutputSchema>;

export const altTextOutputSchema = z.strictObject({
  altText: z.string(),
});
export type AltTextOutput = z.infer<typeof altTextOutputSchema>;

/** The output schemas as JSON Schema, for the docs and the eval suite. */
export function outputJsonSchemas(): Record<'variants' | 'topicIdeas' | 'altText', unknown> {
  return {
    variants: z.toJSONSchema(variantsOutputSchema),
    topicIdeas: z.toJSONSchema(topicIdeasOutputSchema),
    altText: z.toJSONSchema(altTextOutputSchema),
  };
}
