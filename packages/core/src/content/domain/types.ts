import type { Platform } from '@smp/platform-rules';

import type { BrandVoiceContent, ContentLanguage } from '../../ai/domain/types';
import type { MemberRole } from '../../tenancy/domain/types';

// Content entities (architecture 6.2) as the use cases see them. Every entity with a version
// uses optimistic locking: an update names the version it read and fails with 409 otherwise.

export const VARIANT_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'QUEUED',
  'PUBLISHING',
  'RETRYING',
  'PUBLISHED',
  'FAILED',
  'NEEDS_ATTENTION',
  'CANCELED',
  'DELETED',
] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export const IDEA_STATUSES = ['NEW', 'SAVED', 'DISCARDED', 'USED'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** The member acting in a workspace. */
export interface ContentActor {
  userId: string;
  organizationId: string;
  workspaceId: string;
  role: MemberRole;
}

export interface Post {
  id: string;
  workspaceId: string;
  brief: string;
  language: ContentLanguage;
  styleId: string | null;
  brandVoiceId: string | null;
  ideaId: string | null;
  createdById: string | null;
  version: number;
}

export interface PostVariant {
  id: string;
  workspaceId: string;
  postId: string;
  platform: Platform;
  /** The key of the target in the AI task: t1, t2, ... */
  targetKey: string;
  text: string;
  hashtags: string[];
  firstComment: string | null;
  linkUrl: string | null;
  aiWarnings: string[];
  status: VariantStatus;
  version: number;
}

export interface PostStyle {
  id: string;
  /** Null for the presets, which every workspace sees. */
  workspaceId: string | null;
  key: string;
  name: string;
  instructions: string;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface BrandVoice {
  id: string;
  workspaceId: string;
  name: string;
  currentVersionNumber: number;
  isDefault: boolean;
  archivedAt: Date | null;
  version: number;
}

/** An immutable snapshot of a brand voice. */
export interface BrandVoiceVersion {
  id: string;
  workspaceId: string;
  brandVoiceId: string;
  versionNumber: number;
  content: BrandVoiceContent;
  createdById: string | null;
}

export interface Idea {
  id: string;
  workspaceId: string;
  title: string;
  angle: string | null;
  pillar: string | null;
  whyNow: string | null;
  basedOn: string[];
  suggestedPlatforms: Platform[];
  suggestedStyleKey: string | null;
  format: string | null;
  status: IdeaStatus;
  source: 'AI' | 'MANUAL';
  aiGenerationId: string | null;
  createdById: string | null;
  version: number;
}
