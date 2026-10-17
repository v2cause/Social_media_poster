import type {
  CropDto,
  GeneratedVariantDto,
  Locale,
  MediaAssetDto,
  PostDto,
  VariantDto,
} from '@smp/contracts';
import type { Platform } from '@smp/platform-rules';

// The state of the composer (guide step 2.8) as a reducer, so the rules are testable without a
// browser: what is dirty and must be saved, and which variants a generation may overwrite.
// The media of a variant (guide step 3.6) have their own revision: text and media are saved with
// separate requests, but by the same saver and with the same version of the variant. The plan of
// a variant (guide step 4.11) follows the server: the plans of this composer and the live events
// of the publish job update it without touching the text.

/** An asset in a variant, with crop, letterbox and alt text of this use. */
export interface DraftMedia {
  assetId: string;
  crop: CropDto | null;
  letterbox: boolean;
  /** The alt text of this use; null takes the one of the asset. */
  altText: string | null;
  asset: MediaAssetDto;
}

/** Where a variant stands with its publication, as the server reported it last. */
export interface VariantPublishing {
  status: VariantDto['status'];
  socialAccountId: string | null;
  scheduledAt: string | null;
  scheduledTimezone: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  failureCode: string | null;
  isDryRun: boolean;
}

export interface DraftVariant {
  id: string;
  platform: Platform;
  targetKey: string;
  text: string;
  hashtags: string[];
  firstComment: string | null;
  aiWarnings: string[];
  /** The version the server last confirmed (optimistic locking). */
  version: number;
  /** Raised on every local change; a save is current when it saved the latest revision. */
  revision: number;
  savedRevision: number;
  /** The user typed in it since the AI last filled it: generations leave it alone. */
  edited: boolean;
  media: DraftMedia[];
  mediaRevision: number;
  savedMediaRevision: number;
  /** What the server found in the last generated text, until the text changes. */
  check: { forbiddenWords: string[]; autoShortened: boolean } | null;
  publishing: VariantPublishing;
}

export interface DraftPost {
  brief: string;
  language: Locale;
  styleId: string | null;
  brandVoiceId: string | null;
  ideaId: string | null;
  platforms: Platform[];
}

export interface ComposerState {
  postId: string | null;
  post: DraftPost;
  version: number;
  revision: number;
  savedRevision: number;
  variants: DraftVariant[];
  activeVariantId: string | null;
}

export type ComposerAction =
  | { type: 'loaded'; post: PostDto }
  | { type: 'post-changed'; patch: Partial<DraftPost> }
  | { type: 'post-saved'; post: PostDto; revision: number }
  | { type: 'post-version'; version: number }
  | {
      type: 'variant-changed';
      variantId: string;
      patch: Partial<Pick<DraftVariant, 'text' | 'hashtags' | 'firstComment' | 'aiWarnings'>>;
    }
  | { type: 'variant-saved'; variant: VariantDto; revision: number }
  | { type: 'media-changed'; variantId: string; media: DraftMedia[] }
  | { type: 'media-saved'; variant: VariantDto; mediaRevision: number }
  | { type: 'variant-version'; variantId: string; version: number }
  /** A plan, cancel or post of this composer: the variant as the server answered. */
  | { type: 'planned'; variant: VariantDto }
  /** The post as the server holds it now, after a live event of the publish job. */
  | { type: 'synced'; post: PostDto }
  | { type: 'generation-started'; variantIds: readonly string[] }
  | { type: 'generated'; variants: readonly GeneratedVariantDto[] }
  | { type: 'refined'; result: GeneratedVariantDto }
  | { type: 'activated'; variantId: string };

export const isPostDirty = (state: ComposerState): boolean => state.revision !== state.savedRevision;
export const isTextDirty = (variant: DraftVariant): boolean => variant.revision !== variant.savedRevision;
export const isMediaDirty = (variant: DraftVariant): boolean =>
  variant.mediaRevision !== variant.savedMediaRevision;
export const isVariantDirty = (variant: DraftVariant): boolean =>
  isTextDirty(variant) || isMediaDirty(variant);
export const isDirty = (state: ComposerState): boolean =>
  isPostDirty(state) || state.variants.some(isVariantDirty);

/** A new post is created once it has a brief and at least one platform. */
export const readyToCreate = (state: ComposerState): boolean =>
  state.post.brief.trim().length > 0 && state.post.platforms.length > 0;

/** Local changes the auto-save has not stored yet; a new post counts once it can be created. */
export const hasUnsavedChanges = (state: ComposerState): boolean =>
  isDirty(state) && (state.postId !== null || readyToCreate(state));

const toDraftMedia = (variant: VariantDto): DraftMedia[] =>
  [...variant.media]
    .sort((a, b) => a.position - b.position)
    .map((use) => ({
      assetId: use.assetId,
      crop: use.crop,
      letterbox: use.letterbox,
      altText: use.altText,
      asset: use.asset,
    }));

const publishingOf = (variant: VariantDto): VariantPublishing => ({
  status: variant.status,
  socialAccountId: variant.socialAccountId,
  scheduledAt: variant.scheduledAt,
  scheduledTimezone: variant.scheduledTimezone,
  publishedAt: variant.publishedAt,
  externalUrl: variant.externalUrl,
  failureCode: variant.failureCode,
  isDryRun: variant.isDryRun,
});

const toDraft = (variant: VariantDto): DraftVariant => ({
  id: variant.id,
  platform: variant.platform,
  targetKey: variant.targetKey,
  text: variant.text,
  hashtags: variant.hashtags,
  firstComment: variant.firstComment,
  aiWarnings: variant.aiWarnings,
  version: variant.version,
  revision: 0,
  savedRevision: 0,
  edited: false,
  check: null,
  media: toDraftMedia(variant),
  mediaRevision: 0,
  savedMediaRevision: 0,
  publishing: publishingOf(variant),
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * A variant after a fetch of its post. The status and the plan always follow the server, unless
 * the answer is older than what the composer knows. The version follows only when the local
 * variant has no unsaved change and the same content: then the server changed the status, not
 * the text, and the next save must not report a conflict.
 */
function synced(variant: DraftVariant, server: VariantDto): DraftVariant {
  if (server.version < variant.version) {
    return variant;
  }
  const same =
    !isVariantDirty(variant) &&
    server.text === variant.text &&
    sameList(server.hashtags, variant.hashtags) &&
    server.firstComment === variant.firstComment;
  return { ...variant, publishing: publishingOf(server), version: same ? server.version : variant.version };
}

const byTarget = (a: { targetKey: string }, b: { targetKey: string }): number =>
  a.targetKey.localeCompare(b.targetKey, 'en', { numeric: true });

export function initialState(post: DraftPost): ComposerState {
  return {
    postId: null,
    post,
    version: 0,
    revision: 0,
    savedRevision: 0,
    variants: [],
    activeVariantId: null,
  };
}

function fromPost(post: PostDto, ideaId: string | null): ComposerState {
  const variants = post.variants.map(toDraft).sort(byTarget);
  return {
    postId: post.id,
    post: {
      brief: post.brief,
      language: post.language,
      styleId: post.styleId,
      brandVoiceId: post.brandVoiceId,
      ideaId: post.ideaId ?? ideaId,
      platforms: variants.map((variant) => variant.platform),
    },
    version: post.version,
    revision: 0,
    savedRevision: 0,
    variants,
    activeVariantId: variants[0]?.id ?? null,
  };
}

/** The variants after a save of the post: new ones added, dropped ones gone, local edits kept. */
function mergeVariants(current: readonly DraftVariant[], saved: readonly VariantDto[]): DraftVariant[] {
  return saved
    .map((variant) => current.find((draft) => draft.id === variant.id) ?? toDraft(variant))
    .sort(byTarget);
}

function updateVariant(
  state: ComposerState,
  variantId: string,
  update: (variant: DraftVariant) => DraftVariant,
): ComposerState {
  return {
    ...state,
    variants: state.variants.map((variant) => (variant.id === variantId ? update(variant) : variant)),
  };
}

/** Fills a variant with an AI result and marks it for saving. */
const filled = (variant: DraftVariant, result: GeneratedVariantDto): DraftVariant => ({
  ...variant,
  text: result.text,
  hashtags: result.hashtags,
  firstComment: result.firstComment,
  aiWarnings: result.warnings,
  revision: variant.revision + 1,
  edited: false,
  check: { forbiddenWords: result.forbiddenWords, autoShortened: result.autoShortened },
});

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'loaded':
      return fromPost(action.post, state.post.ideaId);
    case 'post-changed':
      return { ...state, post: { ...state.post, ...action.patch }, revision: state.revision + 1 };
    case 'post-saved': {
      const variants = mergeVariants(state.variants, action.post.variants);
      return {
        ...state,
        postId: action.post.id,
        version: action.post.version,
        savedRevision: Math.max(state.savedRevision, action.revision),
        variants,
        activeVariantId: variants.some((variant) => variant.id === state.activeVariantId)
          ? state.activeVariantId
          : (variants[0]?.id ?? null),
      };
    }
    case 'post-version':
      return { ...state, version: action.version };
    case 'variant-changed':
      return updateVariant(state, action.variantId, (variant) => ({
        ...variant,
        ...action.patch,
        revision: variant.revision + 1,
        edited: true,
        check: action.patch.text === undefined ? variant.check : null,
      }));
    case 'variant-saved':
      // An edit turns a failed or canceled variant into a draft again.
      return updateVariant(state, action.variant.id, (variant) => ({
        ...variant,
        version: action.variant.version,
        savedRevision: Math.max(variant.savedRevision, action.revision),
        publishing: publishingOf(action.variant),
      }));
    case 'media-changed':
      return updateVariant(state, action.variantId, (variant) => ({
        ...variant,
        media: action.media,
        mediaRevision: variant.mediaRevision + 1,
      }));
    case 'media-saved':
      return updateVariant(state, action.variant.id, (variant) => ({
        ...variant,
        version: action.variant.version,
        savedMediaRevision: Math.max(variant.savedMediaRevision, action.mediaRevision),
        // Fresh thumbnail URLs, unless the user changed the media again meanwhile.
        media: variant.mediaRevision === action.mediaRevision ? toDraftMedia(action.variant) : variant.media,
        publishing: publishingOf(action.variant),
      }));
    case 'variant-version':
      return updateVariant(state, action.variantId, (variant) => ({ ...variant, version: action.version }));
    case 'planned':
      // Plans run after the pending saves, so the server holds the text of the composer.
      return updateVariant(state, action.variant.id, (variant) => ({
        ...variant,
        version: Math.max(variant.version, action.variant.version),
        publishing: publishingOf(action.variant),
      }));
    case 'synced':
      return {
        ...state,
        variants: state.variants.map((variant) => {
          const server = action.post.variants.find((candidate) => candidate.id === variant.id);
          return server ? synced(variant, server) : variant;
        }),
      };
    case 'generation-started':
      // The user agreed to replace these texts; edits from now on stay protected.
      return {
        ...state,
        variants: state.variants.map((variant) =>
          action.variantIds.includes(variant.id) ? { ...variant, edited: false } : variant,
        ),
      };
    case 'generated':
      return {
        ...state,
        variants: state.variants.map((variant) => {
          const result = action.variants.find((candidate) => candidate.variantId === variant.id);
          return result && !variant.edited ? filled(variant, result) : variant;
        }),
      };
    case 'refined':
      return updateVariant(state, action.result.variantId, (variant) => filled(variant, action.result));
    case 'activated':
      return { ...state, activeVariantId: action.variantId };
  }
}

/** How many results a generation left out because the user edited the variant meanwhile. */
export const skippedResults = (state: ComposerState, results: readonly GeneratedVariantDto[]): number =>
  results.filter((result) => state.variants.find((variant) => variant.id === result.variantId)?.edited)
    .length;
