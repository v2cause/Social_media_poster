import { capabilitiesOf } from '@smp/platform-rules';

import systemPromptV1 from '../../prompts/system/v1.md';
import { STYLE_PRESETS } from './style-presets';

// Layer 1 of the prompt (architecture 5.2): the same for every tenant and therefore cached
// with the first breakpoint. The limits come from @smp/platform-rules, the style catalog from
// the presets, so the prompt never disagrees with the validation.

const placeholders = (): Record<string, string> => {
  const instagram = capabilitiesOf('INSTAGRAM');
  return {
    LINKEDIN_MAX_LENGTH: String(capabilitiesOf('LINKEDIN').text.maxLength),
    INSTAGRAM_MAX_LENGTH: String(instagram.text.maxLength),
    INSTAGRAM_MAX_HASHTAGS: String(instagram.hashtags.max ?? ''),
    INSTAGRAM_MAX_MENTIONS: String(instagram.mentions.max ?? ''),
    FACEBOOK_MAX_LENGTH: String(capabilitiesOf('FACEBOOK').text.maxLength),
    X_MAX_LENGTH: String(capabilitiesOf('X').text.maxLength),
    STYLE_CATALOG: STYLE_PRESETS.map(
      (preset) => `- ${preset.key} (${preset.name}): ${preset.instructions}`,
    ).join('\n'),
  };
};

function render(template: string): string {
  const values = placeholders();
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') {
      throw new Error(`The system prompt uses an unknown placeholder ${match}.`);
    }
    return value;
  });
  return `${rendered.trim()}\n`;
}

let cached: string | undefined;

/** The system prompt of PROMPT_VERSION, rendered once per process. */
export function renderSystemPrompt(): string {
  cached ??= render(systemPromptV1);
  return cached;
}
