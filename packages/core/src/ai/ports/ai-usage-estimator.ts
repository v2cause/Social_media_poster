import type {
  GenerateVariantsInput,
  RefineVariantInput,
  SuggestAltTextInput,
  SuggestTopicsInput,
} from './ai-provider';

export type AiRequest =
  | { task: 'generate'; input: GenerateVariantsInput }
  | { task: 'refine'; input: RefineVariantInput }
  | { task: 'ideas'; input: SuggestTopicsInput }
  | { task: 'altText'; input: SuggestAltTextInput };

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
}

/**
 * An upper estimate of the tokens of a call, for the quota reservation before it (guide step
 * 2.6). Implemented in @smp/ai, which renders the prompts.
 */
export interface AiUsageEstimator {
  estimate(request: AiRequest): TokenEstimate;
}
