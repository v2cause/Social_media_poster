import { readFileSync } from 'node:fs';

import { CONTENT_LANGUAGES, EMOJI_POLICIES, HASHTAG_POLICIES } from '@smp/core';
import { PLATFORMS } from '@smp/platform-rules';
import { z } from 'zod';

// The golden briefs of the eval suite (guide step 2.10): one brand per language, every case a
// brief in a style, generated for all platforms at once like the composer does.

const language = z.enum(CONTENT_LANGUAGES);

const brandSchema = z.object({
  profile: z.object({
    name: z.string().min(1),
    industry: z.string().nullable(),
    targetAudience: z.string().nullable(),
    goals: z.string().nullable(),
    contentPillars: z.array(z.string()),
  }),
  voice: z.object({
    name: z.string().min(1),
    description: z.string(),
    tone: z.array(z.string()),
    dos: z.array(z.string()),
    donts: z.array(z.string()),
    vocabulary: z.array(z.string()),
    forbiddenWords: z.array(z.string()),
    emojiPolicy: z.enum(EMOJI_POLICIES),
    hashtagPolicy: z.enum(HASHTAG_POLICIES),
    examplePosts: z.array(z.string()),
    language,
  }),
});

export const goldenSuiteSchema = z
  .object({
    version: z.number().int().positive(),
    platforms: z.array(z.enum(PLATFORMS)).min(1),
    brands: z.object({ de: brandSchema, en: brandSchema }),
    cases: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          language,
          styleKey: z.string().min(1),
          brief: z.string().trim().min(1).max(4000),
        }),
      )
      .min(1),
  })
  .refine((suite) => new Set(suite.cases.map((entry) => entry.id)).size === suite.cases.length, {
    message: 'duplicate case id',
  });

export type GoldenSuite = z.infer<typeof goldenSuiteSchema>;
export type GoldenCase = GoldenSuite['cases'][number];

export function loadSuite(path: string): GoldenSuite {
  return goldenSuiteSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
