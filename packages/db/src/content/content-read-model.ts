import type { BrandVoiceContent, Crop, IdeaStatus, VariantStatus } from '@smp/core';
import { z } from 'zod';

import { InvalidCursorError } from '../audit/audit-log-read-model';
import type { Platform } from '../generated/prisma/client';
import { withTenantTx, type WorkspaceRef } from '../tenant-context';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { mediaAssetInclude, toMediaAssetView, type MediaAssetView } from '../media/media-read-model';
import { toCrop } from '../media/mappers';
import { brandVoiceContentSchema, toLanguage } from './mappers';

// The read side of the content context (guide step 2.7): what the composer, the post list and
// the settings pages show. Every method names its workspace and runs in that scope.

/** An asset in a variant with crop, letterbox and alt text of this use. */
export interface VariantMediaView {
  id: string;
  assetId: string;
  position: number;
  crop: Crop | null;
  letterbox: boolean;
  altText: string | null;
  asset: MediaAssetView;
}

export interface VariantView {
  id: string;
  postId: string;
  platform: Platform;
  targetKey: string;
  text: string;
  hashtags: string[];
  firstComment: string | null;
  linkUrl: string | null;
  aiWarnings: string[];
  status: VariantStatus;
  media: VariantMediaView[];
  version: number;
  updatedAt: Date;
}

export interface PostView {
  id: string;
  brief: string;
  language: 'de' | 'en';
  styleId: string | null;
  brandVoiceId: string | null;
  ideaId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  variants: VariantView[];
}

export interface PostSummaryView {
  id: string;
  brief: string;
  language: 'de' | 'en';
  styleId: string | null;
  updatedAt: Date;
  variants: { id: string; platform: Platform; status: VariantStatus; excerpt: string }[];
}

export interface StyleView {
  id: string;
  key: string;
  name: string;
  instructions: string;
  isPreset: boolean;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface BrandVoiceView {
  id: string;
  name: string;
  isDefault: boolean;
  archived: boolean;
  currentVersionNumber: number;
  content: BrandVoiceContent;
  version: number;
  updatedAt: Date;
}

export interface BrandVoiceVersionView {
  versionNumber: number;
  content: BrandVoiceContent;
  createdAt: Date;
}

export interface IdeaView {
  id: string;
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
  version: number;
  createdAt: Date;
}

// The post list runs newest first; the cursor is the position of the last post of a page.
const cursorSchema = z.object({ updatedAt: z.iso.datetime(), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidCursorError();
  }
}

const EXCERPT_LENGTH = 140;
const IDEA_LIST_LIMIT = 200;

const excerpt = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH - 3).trimEnd()}...` : line;
};

const variantSelect = {
  id: true,
  postId: true,
  platform: true,
  targetKey: true,
  text: true,
  hashtags: true,
  firstComment: true,
  linkUrl: true,
  aiWarnings: true,
  status: true,
  version: true,
  updatedAt: true,
  media: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      assetId: true,
      position: true,
      crop: true,
      letterbox: true,
      altText: true,
      asset: { include: mediaAssetInclude },
    },
  },
} as const satisfies Prisma.PostVariantSelect;

type VariantRow = Prisma.PostVariantGetPayload<{ select: typeof variantSelect }>;

const toVariantView = (row: VariantRow): VariantView => ({
  ...row,
  media: row.media.map((use) => ({
    id: use.id,
    assetId: use.assetId,
    position: use.position,
    crop: toCrop(use.crop),
    letterbox: use.letterbox,
    altText: use.altText,
    asset: toMediaAssetView(use.asset),
  })),
});

export class ContentReadModel {
  constructor(private readonly base: PrismaClient) {}

  /** The posts of the workspace, recently changed first. */
  listPosts(
    ref: WorkspaceRef,
    page: { cursor?: string; limit: number },
  ): Promise<{ posts: PostSummaryView[]; nextCursor: string | null }> {
    const after = page.cursor ? decodeCursor(page.cursor) : null;
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.post.findMany({
        where: {
          workspaceId: ref.workspaceId,
          ...(after
            ? {
                OR: [
                  { updatedAt: { lt: new Date(after.updatedAt) } },
                  { updatedAt: new Date(after.updatedAt), id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        include: {
          variants: {
            select: { id: true, platform: true, status: true, text: true },
            orderBy: { targetKey: 'asc' },
          },
        },
      });
      const posts = rows.slice(0, page.limit);
      const last = posts.at(-1);
      return {
        posts: posts.map((row) => ({
          id: row.id,
          brief: row.brief,
          language: toLanguage(row.language),
          styleId: row.styleId,
          updatedAt: row.updatedAt,
          variants: row.variants.map((variant) => ({
            id: variant.id,
            platform: variant.platform,
            status: variant.status,
            excerpt: excerpt(variant.text),
          })),
        })),
        nextCursor:
          rows.length > page.limit && last
            ? encodeCursor({ updatedAt: last.updatedAt.toISOString(), id: last.id })
            : null,
      };
    });
  }

  post(ref: WorkspaceRef, postId: string): Promise<PostView | null> {
    return withTenantTx(this.base, ref, async (tx) => {
      const row = await tx.post.findFirst({
        where: { id: postId, workspaceId: ref.workspaceId },
        include: { variants: { select: variantSelect, orderBy: { targetKey: 'asc' } } },
      });
      return row
        ? {
            id: row.id,
            brief: row.brief,
            language: toLanguage(row.language),
            styleId: row.styleId,
            brandVoiceId: row.brandVoiceId,
            ideaId: row.ideaId,
            version: row.version,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            variants: row.variants.map(toVariantView),
          }
        : null;
    });
  }

  variant(ref: WorkspaceRef, variantId: string): Promise<VariantView | null> {
    return withTenantTx(this.base, ref, async (tx) => {
      const row = await tx.postVariant.findFirst({
        where: { id: variantId, workspaceId: ref.workspaceId },
        select: variantSelect,
      });
      return row ? toVariantView(row) : null;
    });
  }

  /** The presets first, then the custom styles of the workspace, each in their order. */
  styles(ref: WorkspaceRef): Promise<StyleView[]> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.postStyle.findMany({
        where: { OR: [{ workspaceId: null }, { workspaceId: ref.workspaceId }] },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return rows
        .map((row) => ({
          id: row.id,
          key: row.key,
          name: row.name,
          instructions: row.instructions,
          isPreset: row.workspaceId === null,
          isActive: row.isActive,
          sortOrder: row.sortOrder,
          version: row.version,
        }))
        .sort((a, b) => Number(b.isPreset) - Number(a.isPreset));
    });
  }

  /** The brand voices with the content of their current version; archived ones last. */
  brandVoices(ref: WorkspaceRef, options: { includeArchived: boolean }): Promise<BrandVoiceView[]> {
    return withTenantTx(this.base, ref, async (tx) => {
      const voices = await tx.brandVoice.findMany({
        where: { workspaceId: ref.workspaceId, ...(options.includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
      });
      const versions = await tx.brandVoiceVersion.findMany({
        where: {
          workspaceId: ref.workspaceId,
          OR: voices.map((voice) => ({ brandVoiceId: voice.id, versionNumber: voice.currentVersionNumber })),
        },
        select: { brandVoiceId: true, content: true },
      });
      const contentOf = new Map(versions.map((version) => [version.brandVoiceId, version.content]));
      return voices.map((voice) => ({
        id: voice.id,
        name: voice.name,
        isDefault: voice.isDefault,
        archived: voice.archivedAt !== null,
        currentVersionNumber: voice.currentVersionNumber,
        content: brandVoiceContentSchema.parse(contentOf.get(voice.id)),
        version: voice.version,
        updatedAt: voice.updatedAt,
      }));
    });
  }

  /** Every version of a brand voice, newest first; null when the voice does not exist. */
  brandVoiceVersions(ref: WorkspaceRef, brandVoiceId: string): Promise<BrandVoiceVersionView[] | null> {
    return withTenantTx(this.base, ref, async (tx) => {
      const voice = await tx.brandVoice.findFirst({
        where: { id: brandVoiceId, workspaceId: ref.workspaceId },
        select: { id: true },
      });
      if (!voice) {
        return null;
      }
      const rows = await tx.brandVoiceVersion.findMany({
        where: { brandVoiceId, workspaceId: ref.workspaceId },
        orderBy: { versionNumber: 'desc' },
      });
      return rows.map((row) => ({
        versionNumber: row.versionNumber,
        content: brandVoiceContentSchema.parse(row.content),
        createdAt: row.createdAt,
      }));
    });
  }

  /** The ideas of the workspace, newest first, optionally with one status or a set of ids. */
  ideas(
    ref: WorkspaceRef,
    filter: { status?: IdeaStatus; ids?: readonly string[] } = {},
  ): Promise<IdeaView[]> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.idea.findMany({
        where: {
          workspaceId: ref.workspaceId,
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.ids ? { id: { in: [...filter.ids] } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: IDEA_LIST_LIMIT,
      });
      return rows.map((row) => ({
        id: row.id,
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
        version: row.version,
        createdAt: row.createdAt,
      }));
    });
  }
}
