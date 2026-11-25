import type { Platform } from '@smp/platform-rules';

// The language of AI-generated content and of the generation tasks (de or en).
export const CONTENT_LANGUAGES = ['de', 'en'] as const;
export type ContentLanguage = (typeof CONTENT_LANGUAGES)[number];

// Effort levels of the model (architecture 5.1). Fixed per route, so the prompt cache holds.
export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export const AI_ROUTES = ['generate', 'refine', 'ideas', 'altText'] as const;
export type AiRoute = (typeof AI_ROUTES)[number];

/** The image formats of a diagram (ADR 0048): 1:1, 4:5 for the Instagram feed, 16:9. */
export const DIAGRAM_FORMATS = ['square', 'portrait', 'landscape'] as const;
export type DiagramFormat = (typeof DIAGRAM_FORMATS)[number];

/** The pixel size of each format: what the prompt asks for and what the JPEG gets. */
export const DIAGRAM_SIZES: Readonly<Record<DiagramFormat, { width: number; height: number }>> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  landscape: { width: 1200, height: 675 },
};

/**
 * The SVG elements a diagram may use: the prompt names them, and the renderer of @smp/media
 * refuses every other one.
 */
export const DIAGRAM_ELEMENTS = [
  'svg',
  'g',
  'defs',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'linearGradient',
  'radialGradient',
  'stop',
  'marker',
  'clipPath',
  'title',
  'desc',
] as const;

export const EMOJI_POLICIES = ['none', 'sparse', 'normal'] as const;
export type EmojiPolicy = (typeof EMOJI_POLICIES)[number];

export const HASHTAG_POLICIES = ['none', 'few', 'normal'] as const;
export type HashtagPolicy = (typeof HASHTAG_POLICIES)[number];

/** The content of an immutable brand voice version (architecture 5.2, layer 2). */
export interface BrandVoiceContent {
  name: string;
  description: string;
  tone: string[];
  dos: string[];
  donts: string[];
  vocabulary: string[];
  forbiddenWords: string[];
  emojiPolicy: EmojiPolicy;
  hashtagPolicy: HashtagPolicy;
  /** Three to five example posts are recommended. */
  examplePosts: string[];
  language: ContentLanguage;
}

/** The company profile of the workspace. */
export interface BrandProfile {
  name: string;
  industry: string | null;
  targetAudience: string | null;
  goals: string | null;
  contentPillars: string[];
}

export interface CustomStyle {
  key: string;
  name: string;
  instructions: string;
}

/** Layer 2 of the prompt: the same for every call of a workspace and brand voice version. */
export interface BrandContext {
  profile: BrandProfile;
  voice: BrandVoiceContent | null;
  customStyles: CustomStyle[];
}

/** A target of a generation: t1, t2, ... with its platform. */
export interface AiTarget {
  key: string;
  platform: Platform;
}

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
export type RefineAction = (typeof REFINE_ACTIONS)[number];

/** One variant as the model returns it (architecture 5.3). */
export interface GeneratedVariant {
  targetKey: string;
  platform: Platform;
  hook: string;
  /** The complete post without the hashtags. */
  text: string;
  hashtags: string[];
  firstComment: string | null;
  callToAction: string | null;
  altTexts: string[];
  warnings: string[];
}

export interface TopicIdea {
  title: string;
  angle: string;
  pillar: string | null;
  whyNow: string;
  basedOn: string[];
  suggestedPlatforms: Platform[];
  suggestedStyleKey: string | null;
  format: string;
}

/** One attempt of a call: the requested model or a server-side fallback model. */
export interface AiAttempt {
  kind: 'message' | 'fallback_message';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** What a provider reports about a call, for AiGeneration and the cost calculation. */
export interface AiCallReport {
  provider: string;
  promptVersion: string;
  modelRequested: string;
  /** The model that produced the answer; null when no model answered. */
  modelServed: string | null;
  effort: AiEffort;
  attempts: AiAttempt[];
  stopReason: string | null;
  refusalCategory: string | null;
  ttftMs: number | null;
  latencyMs: number;
}

// generation.failed codes of the provider (architecture 5.3). QUOTA_EXCEEDED comes from the
// quota check before the call, CANCELED from a client that disconnected.
export const AI_FAILURE_CODES = [
  'REFUSED',
  'TRUNCATED',
  'INVALID_OUTPUT',
  'PROVIDER_ERROR',
  'CANCELED',
] as const;
export type AiFailureCode = (typeof AI_FAILURE_CODES)[number];

export interface AiFailure {
  code: AiFailureCode;
  /** Whether trying again later can succeed (rate limit, overload, network). */
  retryable: boolean;
  /** For logs; never shown to users and free of prompt content. */
  detail: string;
  refusalCategory: string | null;
  /** The HTTP status of a provider error, if any. */
  status: number | null;
}
