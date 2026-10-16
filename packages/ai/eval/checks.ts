import type { AiTarget, ContentLanguage, GeneratedVariant } from '@smp/core';
import {
  composePostText,
  countText,
  findForbiddenWords,
  validatePost,
  type Platform,
} from '@smp/platform-rules';

import { generatedVariantSchema } from '../src/schemas';
import { detectLanguage } from './language';

// The checks of one generated variant (guide step 2.10): valid against the output schema, for the
// right target, within the platform limit, free of the brand voice's forbidden words and in the
// language of the task. Counting and validation are those of the server.

/** The suite attaches no media, so the media rules of a platform do not apply. */
const MEDIA_ISSUES: ReadonlySet<string> = new Set([
  'MEDIA_REQUIRED',
  'TOO_MANY_MEDIA',
  'ASPECT_RATIO_OUT_OF_RANGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'MIXED_MEDIA_NOT_SUPPORTED',
]);

export interface VariantCheck {
  targetKey: string;
  platform: Platform;
  schemaValid: boolean;
  matchesTarget: boolean;
  length: number;
  maxLength: number;
  withinLimit: boolean;
  /** Text issues of the platform besides the length, for example too many hashtags. */
  issues: string[];
  forbiddenWords: string[];
  language: ContentLanguage | 'unknown';
  languageCorrect: boolean;
}

export function checkVariant(
  variant: GeneratedVariant,
  target: AiTarget,
  expected: { language: ContentLanguage; forbiddenWords: readonly string[] },
): VariantCheck {
  const count = countText(target.platform, composePostText(variant.text, variant.hashtags));
  const issues = validatePost({
    platform: target.platform,
    text: variant.text,
    hashtags: variant.hashtags,
    firstComment: variant.firstComment,
  })
    .map((issue) => issue.code)
    .filter((code) => code !== 'TEXT_TOO_LONG' && !MEDIA_ISSUES.has(code));
  const language = detectLanguage(variant.text);
  return {
    targetKey: target.key,
    platform: target.platform,
    schemaValid: generatedVariantSchema.safeParse(variant).success,
    matchesTarget: variant.targetKey === target.key && variant.platform === target.platform,
    length: count.length,
    maxLength: count.max,
    withinLimit: !count.overLimit,
    issues,
    forbiddenWords: findForbiddenWords(
      [variant.text, variant.hashtags.join(' '), variant.firstComment ?? ''],
      expected.forbiddenWords,
    ),
    language,
    languageCorrect: language === expected.language,
  };
}
