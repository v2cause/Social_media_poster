import {
  composePostText,
  countText,
  validatePost,
  type TextCount,
  type ValidationIssue,
} from '@smp/platform-rules';

import type { AiFailureCode, GeneratedVariant } from '../domain/types';
import type { PartialVariant } from '../ports/ai-provider';

// The events of a generation or refinement (architecture 5.3) and the checks of every finished
// variant on the server: the count as the platform counts, the platform rules and the forbidden
// words of the brand voice.

export interface GeneratedVariantResult extends GeneratedVariant {
  /** The variant of the post the text is for. */
  variantId: string;
  count: TextCount;
  issues: ValidationIssue[];
  /** Forbidden words of the brand voice that appear in the text, hashtags or first comment. */
  forbiddenWords: string[];
  /** The first answer was over the limit and was shortened once automatically. */
  autoShortened: boolean;
}

export type GenerationEvent =
  | { type: 'generation.started'; generationId: string }
  | { type: 'variant.partial'; variants: PartialVariant[] }
  | { type: 'variant.reset' }
  | { type: 'generation.completed'; generationId: string; variants: GeneratedVariantResult[] }
  | { type: 'generation.failed'; generationId: string; code: AiFailureCode; retryable: boolean };

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole words and phrases, case-insensitive, in any script. */
export function forbiddenWordsIn(texts: readonly string[], forbidden: readonly string[]): string[] {
  const haystack = texts.join('\n');
  return forbidden.filter((word) => {
    const trimmed = word.trim();
    return (
      trimmed.length > 0 &&
      new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, 'iu').test(haystack)
    );
  });
}

export const countOf = (variant: Pick<GeneratedVariant, 'platform' | 'text' | 'hashtags'>): TextCount =>
  countText(variant.platform, composePostText(variant.text, variant.hashtags));

/** The checks of a variant that is not stored, for example the sample post of a voice test. */
export function checkContent(
  variant: GeneratedVariant,
  context: { forbiddenWords: readonly string[]; autoShortened: boolean },
): Omit<GeneratedVariantResult, 'variantId'> {
  return {
    ...variant,
    count: countOf(variant),
    issues: validatePost({
      platform: variant.platform,
      text: variant.text,
      hashtags: variant.hashtags,
      firstComment: variant.firstComment,
    }),
    forbiddenWords: forbiddenWordsIn(
      [variant.text, variant.hashtags.join(' '), variant.firstComment ?? ''],
      context.forbiddenWords,
    ),
    autoShortened: context.autoShortened,
  };
}

export const checkVariant = (
  variant: GeneratedVariant,
  context: { variantId: string; forbiddenWords: readonly string[]; autoShortened: boolean },
): GeneratedVariantResult => ({ ...checkContent(variant, context), variantId: context.variantId });
