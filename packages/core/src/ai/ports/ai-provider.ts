import type {
  AiCallReport,
  AiEffort,
  AiFailure,
  AiTarget,
  BrandContext,
  ContentLanguage,
  GeneratedVariant,
  RefineAction,
  TopicIdea,
} from '../domain/types';

// The AI port (architecture 5.1, ADR 0007). Implementations: AnthropicAiProvider and
// MockAiProvider in @smp/ai, chosen by AI_PROVIDER.

export interface GenerateVariantsInput {
  brand: BrandContext;
  styleKey: string;
  targets: AiTarget[];
  language: ContentLanguage;
  brief: string;
  /** Descriptions of the attached media, in order (m1, m2, ...). */
  mediaDescriptions: string[];
}

export interface RefineVariantInput {
  brand: BrandContext;
  styleKey: string;
  target: AiTarget;
  language: ContentLanguage;
  action: RefineAction;
  /** The user's own instruction for action "custom". */
  instruction: string | null;
  variant: { text: string; hashtags: string[]; firstComment: string | null };
}

export interface SuggestTopicsInput {
  brand: BrandContext;
  language: ContentLanguage;
  count: number;
  recentPosts: string[];
  topPosts: string[];
  discardedIdeas: string[];
  upcomingDates: { date: string; label: string }[];
}

export type AltTextImage =
  | { kind: 'base64'; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
  | { kind: 'url'; url: string };

export interface SuggestAltTextInput {
  language: ContentLanguage;
  image: AltTextImage;
  /** What the post is about, to focus the description. */
  context: string | null;
}

export interface AiCallOptions {
  effort: AiEffort;
  /** Aborts the call, for example when the client disconnects. */
  signal?: AbortSignal;
}

/** A variant while it streams in; any field can still be missing or incomplete. */
export type PartialVariant = { [K in keyof GeneratedVariant]?: GeneratedVariant[K] };

export type VariantStreamEvent =
  | { type: 'partial'; variants: PartialVariant[] }
  /** The provider starts over (retry after max_tokens): drop the partial output. */
  | { type: 'reset' }
  | { type: 'completed'; variants: GeneratedVariant[]; report: AiCallReport }
  | { type: 'failed'; failure: AiFailure; report: AiCallReport };

export type AiResult<T> =
  { ok: true; value: T; report: AiCallReport } | { ok: false; failure: AiFailure; report: AiCallReport };

export interface AiProvider {
  /** anthropic or mock; stored with every AiGeneration. */
  readonly name: string;
  generateVariants(input: GenerateVariantsInput, options: AiCallOptions): AsyncIterable<VariantStreamEvent>;
  refineVariant(input: RefineVariantInput, options: AiCallOptions): AsyncIterable<VariantStreamEvent>;
  suggestTopics(input: SuggestTopicsInput, options: AiCallOptions): Promise<AiResult<TopicIdea[]>>;
  suggestAltText(input: SuggestAltTextInput, options: AiCallOptions): Promise<AiResult<string>>;
}
