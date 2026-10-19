import type { PublishJobStore, UnclearAttempt, VariantRunResult } from '@smp/core';

import { bytesOf, toSocialConnection } from '../channels/mappers';
import { markNeedsReauth } from '../channels/reauth';
import type { Prisma } from '../generated/prisma/client';
import { toCrop } from '../media/mappers';
import type { TenantTransaction } from '../tenant-context';
import { accountSettingsOf, toPublishJobVariant, type LockedVariantRow } from './publish-job-rows';

// The repositories of the publish job on one transaction (guide step 4.8). The job runs as
// app_user in the tenant of its variant; every method filters by the workspace explicitly and
// row-level security limits it to the scope as well. Claim, lease and end are conditional
// updates on the version, so a run that lost its lease changes nothing.

/** A plain JSON copy: drops undefined values and fails on what JSON cannot hold. */
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

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
        // One statement with the settings of the workspace (guide step 8.5).
        const [row] = await tx.$queryRaw<LockedVariantRow[]>`
          SELECT v.id, v.workspace_id, v.post_id, v.platform, v.status, v.version, v.schedule_version,
                 v.social_account_id, v.text, v.hashtags, v.first_comment, v.link_url, v.scheduled_at,
                 v.queued_at, v.lease_owner, v.lease_until, s.dry_run, s.missed_window_behavior
            FROM post_variant v
            LEFT JOIN workspace_settings s ON s.workspace_id = v.workspace_id
           WHERE v.id = ${variantId}::uuid AND v.workspace_id = ${workspaceId}::uuid
             FOR UPDATE OF v`;
        return row ? toPublishJobVariant(row) : null;
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
        // The next number of the schedule version and the row in one statement (guide step
        // 8.5); the claim holds the row lock of the variant, so no other run counts meanwhile.
        const [row] = await tx.$queryRaw<{ attempt_number: number }[]>`
          INSERT INTO publish_attempt
                 (id, workspace_id, variant_id, schedule_version, attempt_number, trigger, lease_owner, started_at)
          SELECT ${attempt.id}::uuid, ${attempt.workspaceId}::uuid, ${attempt.variantId}::uuid,
                 ${attempt.scheduleVersion}::int, COALESCE(MAX(attempt_number), 0) + 1, ${attempt.trigger}::text,
                 ${attempt.leaseOwner}::text, ${attempt.startedAt}::timestamptz
            FROM publish_attempt
           WHERE workspace_id = ${attempt.workspaceId}::uuid
             AND variant_id = ${attempt.variantId}::uuid
             AND schedule_version = ${attempt.scheduleVersion}::int
          RETURNING attempt_number`;
        if (!row) {
          throw new Error('The publish attempt was not written.');
        }
        return row.attempt_number;
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
                settings: accountSettingsOf(row.settings),
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
