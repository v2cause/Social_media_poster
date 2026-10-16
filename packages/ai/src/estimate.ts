import type { AiRequest, AiUsageEstimator, TokenEstimate } from '@smp/core';

import { estimateTokens } from './pricing';
import { renderBrandContext } from './prompts/render-brand-context';
import {
  renderAltTextTask,
  renderGenerateTask,
  renderRefineTask,
  renderTopicsTask,
} from './prompts/render-task';
import { renderSystemPrompt } from './prompts/system-prompt';

// The estimate of a call for the quota reservation (guide step 2.6): the rendered prompt counts
// as uncached input, and the output gets a generous budget per task, adaptive thinking included.
// The eval suite (step 2.10) measures the real numbers; these budgets follow them.

/** Input tokens of an image at the size the alt text task sends (longest side 1568 px). */
export const IMAGE_TOKENS = 1600;

const OUTPUT_TOKENS = {
  generateBase: 2_000,
  generatePerTarget: 1_500,
  refine: 2_500,
  ideas: 6_000,
  altText: 1_000,
} as const;

export class PromptTokenEstimator implements AiUsageEstimator {
  estimate(request: AiRequest): TokenEstimate {
    const system = renderSystemPrompt();
    switch (request.task) {
      case 'generate':
        return {
          inputTokens: estimateTokens(
            system + renderBrandContext(request.input.brand) + renderGenerateTask(request.input),
          ),
          outputTokens:
            OUTPUT_TOKENS.generateBase + OUTPUT_TOKENS.generatePerTarget * request.input.targets.length,
        };
      case 'refine':
        return {
          inputTokens: estimateTokens(
            system + renderBrandContext(request.input.brand) + renderRefineTask(request.input),
          ),
          outputTokens: OUTPUT_TOKENS.refine,
        };
      case 'ideas':
        return {
          inputTokens: estimateTokens(
            system + renderBrandContext(request.input.brand) + renderTopicsTask(request.input),
          ),
          outputTokens: OUTPUT_TOKENS.ideas,
        };
      case 'altText':
        return {
          inputTokens: estimateTokens(system + renderAltTextTask(request.input)) + IMAGE_TOKENS,
          outputTokens: OUTPUT_TOKENS.altText,
        };
    }
  }
}
