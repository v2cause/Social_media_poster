import type { BrandContext } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { PromptTokenEstimator } from './estimate';
import { estimateTokens } from './pricing';
import { renderSystemPrompt } from './prompts/system-prompt';

const brand: BrandContext = {
  profile: { name: 'Acme', industry: null, targetAudience: null, goals: null, contentPillars: [] },
  voice: null,
  customStyles: [],
};

describe('PromptTokenEstimator', () => {
  const estimator = new PromptTokenEstimator();

  it('counts the whole prompt as input and budgets the output per target', () => {
    const one = estimator.estimate({
      task: 'generate',
      input: {
        brand,
        styleKey: 'professional',
        targets: [{ key: 't1', platform: 'LINKEDIN' }],
        language: 'de',
        brief: 'Neues Büro',
        mediaDescriptions: [],
      },
    });
    const four = estimator.estimate({
      task: 'generate',
      input: {
        brand,
        styleKey: 'professional',
        targets: [
          { key: 't1', platform: 'LINKEDIN' },
          { key: 't2', platform: 'X' },
          { key: 't3', platform: 'INSTAGRAM' },
          { key: 't4', platform: 'FACEBOOK' },
        ],
        language: 'de',
        brief: 'Neues Büro',
        mediaDescriptions: [],
      },
    });

    expect(one.inputTokens).toBeGreaterThan(estimateTokens(renderSystemPrompt()));
    expect(one.outputTokens).toBe(3_500);
    expect(four.outputTokens).toBe(8_000);
    expect(four.inputTokens).toBeGreaterThan(one.inputTokens);
  });

  it('adds the image to the input of an alt text', () => {
    const estimate = estimator.estimate({
      task: 'altText',
      input: { language: 'de', context: null, image: { kind: 'url', url: 'https://example.com/a.jpg' } },
    });

    expect(estimate.inputTokens).toBeGreaterThan(estimateTokens(renderSystemPrompt()) + 1_600);
    expect(estimate.outputTokens).toBe(1_000);
  });
});
