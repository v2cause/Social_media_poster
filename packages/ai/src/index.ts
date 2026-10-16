// The AI providers (Claude API and mock), prompts, output schemas and AI settings.

export { PROMPT_VERSION } from './prompts/version';
export { STYLE_PRESETS, type StylePreset } from './prompts/style-presets';
export { renderSystemPrompt } from './prompts/system-prompt';
export { renderBrandContext } from './prompts/render-brand-context';
export {
  renderAltTextTask,
  renderGenerateTask,
  renderRefineTask,
  renderTopicsTask,
} from './prompts/render-task';
export {
  altTextOutputSchema,
  generatedVariantSchema,
  outputJsonSchemas,
  topicIdeaSchema,
  topicIdeasOutputSchema,
  variantsOutputSchema,
  type AltTextOutput,
  type TopicIdeasOutput,
  type VariantsOutput,
} from './schemas';
export { attemptsFromUsage, estimateTokens } from './pricing';
export { IMAGE_TOKENS, PromptTokenEstimator } from './estimate';
export { partialVariants } from './partial-variants';
export {
  AnthropicAiProvider,
  type AiLogger,
  type AnthropicAiProviderConfig,
} from './anthropic/anthropic-ai-provider';
export { MockAiProvider, type MockAiProviderConfig } from './mock/mock-ai-provider';
export { MOCK_TRIGGERS, type MockTrigger } from './mock/text';
export { AI_PROVIDERS, aiEfforts, aiEnvSchema, checkAiEnv, type AiEnv, type AiProviderName } from './env';
export { createAiProvider, type AiRuntime } from './create-ai-provider';
