import type { PublishJobStore, UnclearAttempt, VariantRunResult } from '@smp/core';

import { bytesOf, toSocialConnection } from '../channels/mappers';
import { markNeedsReauth } from '../channels/reauth';
import type { Prisma } from '../generated/prisma/client';
import { toCrop } from '../media/mappers';
import type { TenantTransaction } from '../tenant-context';

// The repositories of the publish job on one transaction (guide step 4.8). The job runs as
// app_user in the tenant of its variant; every method filters by the workspace explicitly and
// row-level security limits it to the scope as well. Claim, lease and end are conditional
// updates on the version, so a run that lost its lease changes nothing.

/** A plain JSON copy: drops undefined values and fails on what JSON cannot hold. */
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** SocialAccount.settings as an object; anything else counts as no settings. */
const settingsOf = (value: Prisma.JsonValue): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};

const runResultData = (result: VariantRunResult): Prisma.PostVariantUpdateManyMutationInput =>
  result.status === 'PUBLISHED'
    ? {
        status: 'PUBLISHED',
        publishedAt: result.publishedAt,
        externalPostId: result.externalPostId,
        externalUrl: result.externalUrl,
        contentHash: result.contentHash,
        isDryRun: result.isDryRun,
        metricsNextAt: result.metricsNextAt,
        metricsStep: 0,
        failureCode: null,
        lastError: null,
      }
    : { status: result.status, failureCode: result.failureCode, lastError: result.lastError };

export function createPrismaPublishJobStore(tx: TenantTransaction): PublishJobStore {
  return {
    variants: {
      async lockForJob(workspaceId, variantId) {
        // The row lock lasts until the end of the transaction: claims of the same variant wait.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM post_variant
           WHERE id = ${variantId}::uuid AND workspace_id = ${workspaceId}::uuid
             FOR UPDATE`;
        if (locked.length === 0) {
          return null;
        }
        const row = await tx.postVariant.findFirst({
          where: { id: variantId, workspaceId },
          select: {
            id: true,
            workspaceId: true,
            postId: true,
            platform: true,
            status: true,
            version: true,
            scheduleVersion: true,
            socialAccountId: true,
            text: true,
            hashtags: true,
            firstComment: true,
            linkUrl: true,
            scheduledAt: true,
            queuedAt: true,
            leaseOwner: true,
            leaseUntil: true,
          },
        });
        const settings = await tx.workspaceSettings.findUnique({
          where: { workspaceId },
          select: { dryRun: true, missedWindowBehavior: true },
        });
        return row
          ? {
              ...row,
              dryRun: settings?.dryRun ?? false,
              missedWindowBehavior: settings?.missedWindowBehavior ?? 'FAIL',
            }
          : null;
      },
      async claim(workspaceId, variantId, version, lease) {
        const { count } = await tx.postVariant.updateMany({
          where: { id: variantId, workspaceId, version },
          data: {
            status: 'PUBLISHING',
            leaseOwner: lease.owner,
            leaseUntil: lease.until,
            version: { increment: 1 },
          },
        });
        return count === 1 ? version + 1 : null;
      },
      async extendLease(workspaceId, variantId, version, lease) {
        const { count } = await tx.postVariant.updateMany({
          where: { id: variantId, workspaceId, version, leaseOwner: lease.owner, status: 'PUBLISHING' },
          data: { leaseUntil: lease.until, version: { increment: 1 } },
        });
        return count === 1 ? version + 1 : null;
      },
      async finish(workspaceId, variantId, version, owner, result) {
        const { count } = await tx.postVariant.updateMany({
          where: { id: variantId, workspaceId, version, leaseOwner: owner, status: 'PUBLISHING' },
          data: { ...runResultData(result), leaseOwner: null, leaseUntil: null, version: { increment: 1 } },
        });
        return count === 1;
      },
      async fail(workspaceId, variantId, version, failureCode) {
        const { count } = await tx.postVariant.updateMany({
          where: { id: variantId, workspaceId, version },
          data: {
            status: 'FAILED',
            failureCode,
            lastError: null,
            leaseOwner: null,
            leaseUntil: null,
            version: { increment: 1 },
          },
        });
        return count === 1;
      },
    },

    attempts: {
      async unclear(workspaceId, variantId) {
        const rows = await tx.publishAttempt.findMany({
          where: { workspaceId, variantId, outcome: { in: ['STARTED', 'UNKNOWN'] } },
          orderBy: { startedAt: 'asc' },
          select: { scheduleVersion: true, outcome: true, startedAt: true },
        });
        return rows.flatMap(({ scheduleVersion, outcome, startedAt }): UnclearAttempt[] =>
          outcome === 'STARTED' || outcome === 'UNKNOWN' ? [{ scheduleVersion, outcome, startedAt }] : [],
        );
      },
      async start(attempt) {
        const last = await tx.publishAttempt.aggregate({
          where: {
            workspaceId: attempt.workspaceId,
            variantId: attempt.variantId,
            scheduleVersion: attempt.scheduleVersion,
          },
          _max: { attemptNumber: true },
        });
        const attemptNumber = (last._max.attemptNumber ?? 0) + 1;
        await tx.publishAttempt.create({
          data: {
            id: attempt.id,
            workspaceId: attempt.workspaceId,
            variantId: attempt.variantId,
            scheduleVersion: attempt.scheduleVersion,
            attemptNumber,
            trigger: attempt.trigger,
            leaseOwner: attempt.leaseOwner,
            startedAt: attempt.startedAt,
          },
        });
        return attemptNumber;
      },
      async markSent(workspaceId, attemptId) {
        await tx.publishAttempt.updateMany({
          where: { id: attemptId, workspaceId },
          data: { outcome: 'UNKNOWN' },
        });
      },
      async finish(workspaceId, attemptId, result) {
        await tx.publishAttempt.updateMany({
          where: { id: attemptId, workspaceId },
          data: {
            outcome: result.outcome,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
            externalPostId: result.externalPostId,
            meta: json(result.meta),
            finishedAt: result.finishedAt,
          },
        });
      },
    },

    targets: {
      async find(workspaceId, accountId) {
        const row = await tx.socialAccount.findFirst({
          where: { id: accountId, workspaceId },
          include: { connection: true },
        });
        return row
          ? {
              account: {
                id: row.id,
                workspaceId: row.workspaceId,
                connectionId: row.connectionId,
                platform: row.platform,
                type: row.type,
                externalId: row.externalId,
                name: row.name,
                handle: row.handle,
                settings: settingsOf(row.settings),
              },
              disconnectedAt: row.disconnectedAt,
              accessTokenSealed: row.accessTokenSealed,
              connection: toSocialConnection(row.connection),
            }
          : null;
      },
    },

    connections: {
      async find(workspaceId, connectionId) {
        const row = await tx.socialConnection.findFirst({ where: { id: connectionId, workspaceId } });
        return row ? toSocialConnection(row) : null;
      },
      async storeRefresh(workspaceId, connectionId, version, tokens) {
        const { count } = await tx.socialConnection.updateMany({
          where: { id: connectionId, workspaceId, version },
          data: {
            accessTokenSealed: bytesOf(tokens.accessTokenSealed),
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenSealed:
              tokens.refreshTokenSealed === null ? null : bytesOf(tokens.refreshTokenSealed),
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            scopes: tokens.scopes,
            lastRefreshedAt: tokens.refreshedAt,
            version: { increment: 1 },
          },
        });
        return count === 1;
      },
      markNeedsReauth: (workspaceId, connectionId, reason) =>
        markNeedsReauth(tx, workspaceId, connectionId, reason),
    },

    media: {
      async itemsOf(workspaceId, variantId) {
        const rows = await tx.postMedia.findMany({
          where: { variantId, workspaceId },
          orderBy: { position: 'asc' },
          select: {
            assetId: true,
            crop: true,
            letterbox: true,
            altText: true,
            asset: { select: { altText: true } },
          },
        });
        return rows.map((row) => ({
          assetId: row.assetId,
          crop: toCrop(row.crop),
          letterbox: row.letterbox,
          altText: row.altText ?? row.asset.altText,
        }));
      },
      async rendition(workspaceId, assetId, profile, cropHash) {
        return tx.mediaRendition.findFirst({
          where: { workspaceId, assetId, profile, cropHash },
          select: { storageKey: true, mimeType: true, width: true, height: true, sizeBytes: true },
        });
      },
    },

    costs: {
      async record(entries) {
        // Booked once per source and operation, like the usage ledger.
        await tx.apiCostRecord.createMany({
          data: entries.map((entry) => ({ ...entry, costMicros: BigInt(entry.costMicros) })),
          skipDuplicates: true,
        });
      },
    },

    outbox: {
      async add(workspaceId, event) {
        await tx.outboxEvent.create({
          data: { workspaceId, type: event.type, payload: event.payload },
        });
      },
    },
  };
}
