import { createHash } from 'node:crypto';

import {
  canonicalJson,
  type BrandVoiceVersion,
  type ContentScope,
  type ContentStore,
  type IdeaStatus,
} from '@smp/core';
import { z } from 'zod';

import { prismaAuditTrail, type RequestOrigin } from '../audit/prisma-audit-trail';
import type { TenantTransaction } from '../tenant-context';
import { toBrandVoice, toBrandVoiceVersion, toIdea, toLanguage, toPost, toStyle, toVariant } from './mappers';

// The repositories of the content context on one transaction (guide step 2.7). Every method
// filters by the workspace explicitly; row-level security limits it to the scope as well.
// Conditional updates match id, workspace and version and raise the version, so a stale
// version changes nothing.

/** Titles at least this similar (pg_trgm, 0 to 1) count as the same idea. */
const IDEA_SIMILARITY = 0.6;

const effortOverridesSchema = z.record(z.string(), z.string()).nullable();

const contentHash = (version: BrandVoiceVersion): string =>
  createHash('sha256').update(canonicalJson(version.content)).digest('hex');

const versionRow = (version: BrandVoiceVersion) => ({
  id: version.id,
  workspaceId: version.workspaceId,
  brandVoiceId: version.brandVoiceId,
  versionNumber: version.versionNumber,
  // A copy as a plain object type, which Prisma accepts as JSON.
  content: { ...version.content },
  contentHash: contentHash(version),
  createdById: version.createdById,
});

export function createPrismaContentStore(
  tx: TenantTransaction,
  scope: ContentScope,
  origin: RequestOrigin,
): ContentStore {
  const bump = { version: { increment: 1 } } as const;

  return {
    posts: {
      async find(workspaceId, postId) {
        const row = await tx.post.findFirst({ where: { id: postId, workspaceId } });
        return row ? toPost(row) : null;
      },
      async insert(post) {
        await tx.post.create({ data: post });
      },
      async update(workspaceId, postId, version, patch) {
        const { count } = await tx.post.updateMany({
          where: { id: postId, workspaceId, version },
          data: { ...patch, ...bump },
        });
        return count === 1;
      },
      async touch(workspaceId, postId, version) {
        const { count } = await tx.post.updateMany({
          where: { id: postId, workspaceId, version },
          data: bump,
        });
        return count === 1;
      },
      async delete(workspaceId, postId) {
        await tx.post.deleteMany({ where: { id: postId, workspaceId } });
      },
      async recentTexts(workspaceId, limit) {
        const posts = await tx.post.findMany({
          where: { workspaceId, variants: { some: { text: { not: '' } } } },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: limit,
          select: {
            variants: {
              where: { text: { not: '' } },
              orderBy: { targetKey: 'asc' },
              take: 1,
              select: { text: true },
            },
          },
        });
        return posts.flatMap((post) => post.variants.map((variant) => variant.text));
      },
    },

    variants: {
      async find(workspaceId, variantId) {
        const row = await tx.postVariant.findFirst({ where: { id: variantId, workspaceId } });
        return row ? toVariant(row) : null;
      },
      async ofPost(workspaceId, postId) {
        const rows = await tx.postVariant.findMany({
          where: { postId, workspaceId },
          orderBy: { targetKey: 'asc' },
        });
        return rows.map(toVariant);
      },
      async insertMany(variants) {
        if (variants.length > 0) {
          await tx.postVariant.createMany({ data: [...variants] });
        }
      },
      async update(workspaceId, variantId, version, patch) {
        const { count } = await tx.postVariant.updateMany({
          where: { id: variantId, workspaceId, version },
          data: { ...patch, ...bump },
        });
        return count === 1;
      },
      async deleteMany(workspaceId, variantIds) {
        if (variantIds.length > 0) {
          await tx.postVariant.deleteMany({ where: { id: { in: [...variantIds] }, workspaceId } });
        }
      },
    },

    styles: {
      async find(workspaceId, styleId) {
        const row = await tx.postStyle.findFirst({
          where: { id: styleId, OR: [{ workspaceId }, { workspaceId: null }] },
        });
        return row ? toStyle(row) : null;
      },
      async keyTaken(workspaceId, key, excludeStyleId) {
        const count = await tx.postStyle.count({
          where: { workspaceId, key, ...(excludeStyleId ? { id: { not: excludeStyleId } } : {}) },
        });
        return count > 0;
      },
      async nextSortOrder(workspaceId) {
        const { _max } = await tx.postStyle.aggregate({ where: { workspaceId }, _max: { sortOrder: true } });
        return _max.sortOrder === null ? 0 : _max.sortOrder + 1;
      },
      async insert(style) {
        await tx.postStyle.create({ data: style });
      },
      async update(workspaceId, styleId, version, patch) {
        const { count } = await tx.postStyle.updateMany({
          where: { id: styleId, workspaceId, version },
          data: { ...patch, ...bump },
        });
        return count === 1;
      },
      async activeCustom(workspaceId) {
        const rows = await tx.postStyle.findMany({
          where: { workspaceId, isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        });
        return rows.map(toStyle);
      },
    },

    brandVoices: {
      async find(workspaceId, brandVoiceId) {
        const row = await tx.brandVoice.findFirst({ where: { id: brandVoiceId, workspaceId } });
        return row ? toBrandVoice(row) : null;
      },
      async findDefault(workspaceId) {
        const row = await tx.brandVoice.findFirst({
          where: { workspaceId, isDefault: true, archivedAt: null },
        });
        return row ? toBrandVoice(row) : null;
      },
      async insert(voice, firstVersion) {
        await tx.brandVoice.create({ data: voice });
        await tx.brandVoiceVersion.create({ data: versionRow(firstVersion) });
      },
      async update(workspaceId, brandVoiceId, version, patch) {
        const { count } = await tx.brandVoice.updateMany({
          where: { id: brandVoiceId, workspaceId, version },
          data: { ...patch, ...bump },
        });
        return count === 1;
      },
      async clearDefault(workspaceId, exceptBrandVoiceId) {
        await tx.brandVoice.updateMany({
          where: { workspaceId, isDefault: true, id: { not: exceptBrandVoiceId } },
          data: { isDefault: false, ...bump },
        });
      },
      async addVersion(version) {
        await tx.brandVoiceVersion.create({ data: versionRow(version) });
      },
      async findVersion(workspaceId, brandVoiceId, versionNumber) {
        const row = await tx.brandVoiceVersion.findFirst({
          where: { workspaceId, brandVoiceId, versionNumber },
        });
        return row ? toBrandVoiceVersion(row) : null;
      },
    },

    ideas: {
      async find(workspaceId, ideaId) {
        const row = await tx.idea.findFirst({ where: { id: ideaId, workspaceId } });
        return row ? toIdea(row) : null;
      },
      async insertMany(ideas) {
        if (ideas.length > 0) {
          await tx.idea.createMany({ data: [...ideas] });
        }
      },
      async update(workspaceId, ideaId, version, patch) {
        const { count } = await tx.idea.updateMany({
          where: { id: ideaId, workspaceId, version },
          data: { ...patch, ...bump },
        });
        return count === 1;
      },
      async setStatus(workspaceId, ideaId, status: IdeaStatus) {
        await tx.idea.updateMany({ where: { id: ideaId, workspaceId }, data: { status, ...bump } });
      },
      async similarTitles(workspaceId, titles) {
        if (titles.length === 0) {
          return [];
        }
        // The % operator uses the trigram index; similarity() then applies the stricter bound.
        const rows = await tx.$queryRaw<{ title: string }[]>`
          SELECT candidate.title
            FROM unnest(${[...titles]}::text[]) AS candidate(title)
           WHERE EXISTS (
                 SELECT 1 FROM idea
                  WHERE idea.workspace_id = ${workspaceId}::uuid
                    AND idea.title % candidate.title
                    AND similarity(idea.title, candidate.title) >= ${IDEA_SIMILARITY})`;
        return rows.map((row) => row.title);
      },
      async recentTitles(workspaceId, status, limit) {
        const rows = await tx.idea.findMany({
          where: { workspaceId, status },
          orderBy: { updatedAt: 'desc' },
          take: limit,
          select: { title: true },
        });
        return rows.map((row) => row.title);
      },
    },

    workspaces: {
      async profileOf(workspaceId) {
        const row = await tx.workspace.findFirstOrThrow({
          where: { id: workspaceId, organizationId: scope.organizationId },
          select: { name: true, industry: true, targetAudience: true, goals: true, contentPillars: true },
        });
        return row;
      },
      async languageOf(workspaceId) {
        const row = await tx.workspace.findFirstOrThrow({
          where: { id: workspaceId, organizationId: scope.organizationId },
          select: { contentLanguage: true },
        });
        return toLanguage(row.contentLanguage);
      },
      async effortOverridesOf(workspaceId) {
        const row = await tx.workspaceSettings.findUnique({
          where: { workspaceId },
          select: { effortOverrides: true },
        });
        return effortOverridesSchema.parse(row?.effortOverrides ?? null);
      },
    },

    audit: prismaAuditTrail(tx, scope.userId, origin),
  };
}
