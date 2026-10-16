import {
  CONTENT_LANGUAGES,
  EMOJI_POLICIES,
  HASHTAG_POLICIES,
  type BrandVoice,
  type BrandVoiceContent,
  type BrandVoiceVersion,
  type ContentLanguage,
  type Idea,
  type Post,
  type PostStyle,
  type PostVariant,
} from '@smp/core';
import { z } from 'zod';

import type * as Prisma from '../generated/prisma/client';

// Prisma rows to the entities of the core. JSON columns and free-text language columns are
// validated like every other external input (guide B.1).

const languageSchema = z.enum(CONTENT_LANGUAGES);

export const toLanguage = (value: string): ContentLanguage => languageSchema.parse(value);

export const brandVoiceContentSchema = z.object({
  name: z.string(),
  description: z.string(),
  tone: z.array(z.string()),
  dos: z.array(z.string()),
  donts: z.array(z.string()),
  vocabulary: z.array(z.string()),
  forbiddenWords: z.array(z.string()),
  emojiPolicy: z.enum(EMOJI_POLICIES),
  hashtagPolicy: z.enum(HASHTAG_POLICIES),
  examplePosts: z.array(z.string()),
  language: languageSchema,
}) satisfies z.ZodType<BrandVoiceContent>;

export const toPost = (row: Prisma.Post): Post => ({
  id: row.id,
  workspaceId: row.workspaceId,
  brief: row.brief,
  language: toLanguage(row.language),
  styleId: row.styleId,
  brandVoiceId: row.brandVoiceId,
  ideaId: row.ideaId,
  createdById: row.createdById,
  version: row.version,
});

export const toVariant = (row: Prisma.PostVariant): PostVariant => ({
  id: row.id,
  workspaceId: row.workspaceId,
  postId: row.postId,
  platform: row.platform,
  targetKey: row.targetKey,
  text: row.text,
  hashtags: row.hashtags,
  firstComment: row.firstComment,
  linkUrl: row.linkUrl,
  aiWarnings: row.aiWarnings,
  status: row.status,
  version: row.version,
});

export const toStyle = (row: Prisma.PostStyle): PostStyle => ({
  id: row.id,
  workspaceId: row.workspaceId,
  key: row.key,
  name: row.name,
  instructions: row.instructions,
  isActive: row.isActive,
  sortOrder: row.sortOrder,
  version: row.version,
});

export const toBrandVoice = (row: Prisma.BrandVoice): BrandVoice => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  currentVersionNumber: row.currentVersionNumber,
  isDefault: row.isDefault,
  archivedAt: row.archivedAt,
  version: row.version,
});

export const toBrandVoiceVersion = (row: Prisma.BrandVoiceVersion): BrandVoiceVersion => ({
  id: row.id,
  workspaceId: row.workspaceId,
  brandVoiceId: row.brandVoiceId,
  versionNumber: row.versionNumber,
  content: brandVoiceContentSchema.parse(row.content),
  createdById: row.createdById,
});

export const toIdea = (row: Prisma.Idea): Idea => ({
  id: row.id,
  workspaceId: row.workspaceId,
  title: row.title,
  angle: row.angle,
  pillar: row.pillar,
  whyNow: row.whyNow,
  basedOn: row.basedOn,
  suggestedPlatforms: row.suggestedPlatforms,
  suggestedStyleKey: row.suggestedStyleKey,
  format: row.format,
  status: row.status,
  source: row.source,
  aiGenerationId: row.aiGenerationId,
  createdById: row.createdById,
  version: row.version,
});
