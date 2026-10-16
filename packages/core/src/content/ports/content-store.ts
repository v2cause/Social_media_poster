import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { BrandProfile, ContentLanguage } from '../../ai/domain/types';
import type {
  BrandVoice,
  BrandVoiceVersion,
  Idea,
  IdeaStatus,
  Post,
  PostStyle,
  PostVariant,
} from '../domain/types';

// The repositories of the content context (guide step 2.7). Every method names the workspace;
// row-level security limits the statements to it as well (architecture 6.3). Updates are
// conditional on the version the caller read and return false when it is stale.

export type PostPatch = Partial<Pick<Post, 'brief' | 'language' | 'styleId' | 'brandVoiceId'>>;
export type VariantPatch = Partial<
  Pick<PostVariant, 'text' | 'hashtags' | 'firstComment' | 'linkUrl' | 'aiWarnings' | 'status'>
>;
export type StylePatch = Partial<Pick<PostStyle, 'name' | 'key' | 'instructions' | 'isActive' | 'sortOrder'>>;
export type BrandVoicePatch = Partial<
  Pick<BrandVoice, 'name' | 'currentVersionNumber' | 'isDefault' | 'archivedAt'>
>;
export type IdeaPatch = Partial<Pick<Idea, 'status' | 'title' | 'angle'>>;

export interface PostRepository {
  find(workspaceId: string, postId: string): Promise<Post | null>;
  insert(post: Post): Promise<void>;
  update(workspaceId: string, postId: string, version: number, patch: PostPatch): Promise<boolean>;
  /** Raises the version without other changes, when only the variants of the post changed. */
  touch(workspaceId: string, postId: string, version: number): Promise<boolean>;
  delete(workspaceId: string, postId: string): Promise<void>;
  /** The texts of the latest posts (their first non-empty variant), newest first. */
  recentTexts(workspaceId: string, limit: number): Promise<string[]>;
}

export interface VariantRepository {
  find(workspaceId: string, variantId: string): Promise<PostVariant | null>;
  ofPost(workspaceId: string, postId: string): Promise<PostVariant[]>;
  insertMany(variants: readonly PostVariant[]): Promise<void>;
  update(workspaceId: string, variantId: string, version: number, patch: VariantPatch): Promise<boolean>;
  deleteMany(workspaceId: string, variantIds: readonly string[]): Promise<void>;
}

export interface StyleRepository {
  /** A preset or a style of the workspace. */
  find(workspaceId: string, styleId: string): Promise<PostStyle | null>;
  /** Whether the workspace has a custom style with this key, other than the excluded one. */
  keyTaken(workspaceId: string, key: string, excludeStyleId?: string): Promise<boolean>;
  /** The sort position after the last custom style. */
  nextSortOrder(workspaceId: string): Promise<number>;
  insert(style: PostStyle): Promise<void>;
  update(workspaceId: string, styleId: string, version: number, patch: StylePatch): Promise<boolean>;
  /** The active custom styles, for the brand context of the AI. */
  activeCustom(workspaceId: string): Promise<PostStyle[]>;
}

export interface BrandVoiceRepository {
  find(workspaceId: string, brandVoiceId: string): Promise<BrandVoice | null>;
  /** The voice marked as default, if it is not archived. */
  findDefault(workspaceId: string): Promise<BrandVoice | null>;
  insert(voice: BrandVoice, firstVersion: BrandVoiceVersion): Promise<void>;
  update(
    workspaceId: string,
    brandVoiceId: string,
    version: number,
    patch: BrandVoicePatch,
  ): Promise<boolean>;
  /** Clears the default flag of every other voice of the workspace. */
  clearDefault(workspaceId: string, exceptBrandVoiceId: string): Promise<void>;
  addVersion(version: BrandVoiceVersion): Promise<void>;
  findVersion(
    workspaceId: string,
    brandVoiceId: string,
    versionNumber: number,
  ): Promise<BrandVoiceVersion | null>;
}

export interface IdeaRepository {
  find(workspaceId: string, ideaId: string): Promise<Idea | null>;
  insertMany(ideas: readonly Idea[]): Promise<void>;
  update(workspaceId: string, ideaId: string, version: number, patch: IdeaPatch): Promise<boolean>;
  /** Sets the status without a version check, for example USED when a post is created from it. */
  setStatus(workspaceId: string, ideaId: string, status: IdeaStatus): Promise<void>;
  /** Of the given titles, those that resemble an existing idea of the workspace (pg_trgm). */
  similarTitles(workspaceId: string, titles: readonly string[]): Promise<string[]>;
  /** The latest titles with a status, for example the discarded ones as negative examples. */
  recentTitles(workspaceId: string, status: IdeaStatus, limit: number): Promise<string[]>;
}

export interface WorkspaceProfileReader {
  /** The company profile of the workspace for the brand context. */
  profileOf(workspaceId: string): Promise<BrandProfile>;
  /** The content language of the workspace. */
  languageOf(workspaceId: string): Promise<ContentLanguage>;
  /** The AI effort the workspace set per route, if any. */
  effortOverridesOf(workspaceId: string): Promise<Record<string, string> | null>;
}

/** The repositories of one transaction. */
export interface ContentStore {
  posts: PostRepository;
  variants: VariantRepository;
  styles: StyleRepository;
  brandVoices: BrandVoiceRepository;
  ideas: IdeaRepository;
  workspaces: WorkspaceProfileReader;
  audit: AuditTrail;
}

/** The tenant of a unit of work: the workspace of the request and the acting user. */
export interface ContentScope {
  userId: string;
  organizationId: string;
  workspaceId: string;
}

/** Runs work in one transaction with the scope set at its start. */
export interface ContentUnitOfWork {
  run<T>(scope: ContentScope, work: (store: ContentStore) => Promise<T>): Promise<T>;
}
