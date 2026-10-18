import {
  GDPR_REQUEST_KINDS,
  GDPR_REQUEST_STATUSES,
  runsPaid,
  type GdprRequest,
  type GdprRequestDetails,
  type GdprRequestKind,
  type GdprRequestRepository,
  type GdprRequestRunner,
  type GdprScope,
  type GdprStore,
  type GdprUnitOfWork,
  type OrganizationDeletion,
} from '@smp/core';
import { z } from 'zod';

import { prismaAuditTrail, type RequestOrigin } from '../audit/prisma-audit-trail';
import { toSubscription } from '../billing/prisma-subscriptions';
import type { PrismaClient } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';
import { withTenantTx, type TenantTransaction } from '../tenant-context';

// The requests of data protection (guide steps 8.1 and 8.2, ADR 0036 and 0037). The owners create
// and read them as app_user in their organization and may cancel an erasure that waits; the worker
// role "gdpr" runs them as app_system. A partial unique index keeps one open request per kind and
// organization.

const OPEN: ('PENDING' | 'RUNNING')[] = ['PENDING', 'RUNNING'];

const detailsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);

interface GdprRequestRow {
  id: string;
  organizationId: string;
  kind: string;
  status: string;
  requestedById: string | null;
  runAfter: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  objectKey: string | null;
  expiresAt: Date | null;
  details: unknown;
  createdAt: Date;
}

export const toGdprRequest = (row: GdprRequestRow): GdprRequest => ({
  id: row.id,
  organizationId: row.organizationId,
  kind: z.enum(GDPR_REQUEST_KINDS).parse(row.kind),
  status: z.enum(GDPR_REQUEST_STATUSES).parse(row.status),
  requestedById: row.requestedById,
  runAfter: row.runAfter,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  objectKey: row.objectKey,
  expiresAt: row.expiresAt,
  details: detailsSchema.parse(row.details),
  createdAt: row.createdAt,
});

const prismaGdprRequests = (tx: TenantTransaction): GdprRequestRepository => ({
  async create(request) {
    // ON CONFLICT DO NOTHING: an open request of the same kind must not abort the transaction.
    const { count } = await tx.gdprRequest.createMany({
      data: [
        {
          id: request.id,
          organizationId: request.organizationId,
          kind: request.kind,
          status: 'PENDING',
          requestedById: request.requestedById,
          runAfter: request.runAfter,
          details: request.details,
          createdAt: request.createdAt,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  },
  async findOpen(organizationId, kind) {
    const row = await tx.gdprRequest.findFirst({ where: { organizationId, kind, status: { in: OPEN } } });
    return row ? toGdprRequest(row) : null;
  },
  async find(organizationId, requestId) {
    const row = await tx.gdprRequest.findFirst({ where: { organizationId, id: requestId } });
    return row ? toGdprRequest(row) : null;
  },
  async listRecent(organizationId, kind, limit) {
    const rows = await tx.gdprRequest.findMany({
      where: { organizationId, kind },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toGdprRequest);
  },
  async cancel(organizationId, requestId, at) {
    // The policy erasure_cancel lets app_user move a waiting erasure to CANCELED, nothing else.
    const { count } = await tx.gdprRequest.updateMany({
      where: { id: requestId, organizationId, kind: 'ERASURE', status: 'PENDING' },
      data: { status: 'CANCELED', completedAt: at },
    });
    return count === 1;
  },
});

const prismaOrganizationDeletion = (tx: TenantTransaction): OrganizationDeletion => ({
  async find(organizationId) {
    const row = await tx.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        workspaces: { select: { id: true }, orderBy: { createdAt: 'asc' } },
        subscription: { include: { plan: true } },
      },
    });
    if (!row) {
      return null;
    }
    const subscription = row.subscription ? toSubscription(row.subscription) : null;
    return {
      id: row.id,
      name: row.name,
      deletedAt: row.deletedAt,
      workspaceIds: row.workspaces.map((workspace) => workspace.id),
      renewingSubscription: runsPaid(subscription) && !subscription.cancelAtPeriodEnd,
    };
  },
  async markDeleted(organizationId, at) {
    await tx.organization.update({ where: { id: organizationId }, data: { deletedAt: at } });
  },
  async restore(organizationId) {
    await tx.organization.update({ where: { id: organizationId }, data: { deletedAt: null } });
  },
});

/** GdprUnitOfWork on PostgreSQL: one interactive transaction per run as app_user, scope set at its start. */
export class PrismaGdprUnitOfWork implements GdprUnitOfWork {
  constructor(
    private readonly base: PrismaClient,
    private readonly origin: () => RequestOrigin = () => ({}),
  ) {}

  run<T>(scope: GdprScope, work: (store: GdprStore) => Promise<T>): Promise<T> {
    const origin = this.origin();
    return withTenantTx(this.base, scope, (tx) =>
      work({
        requests: prismaGdprRequests(tx),
        organizations: prismaOrganizationDeletion(tx),
        audit: prismaAuditTrail(tx, scope.userId, origin),
      }),
    );
  }
}

/** The requests as the worker role "gdpr" runs them (app_system). */
export class PrismaGdprRequestRunner implements GdprRequestRunner {
  constructor(private readonly system: SystemPrismaClient) {}

  async claim(requestId: string, at: Date): Promise<GdprRequest | null> {
    const rows = await runInSystemScope(() =>
      this.system.gdprRequest.updateManyAndReturn({
        where: { id: requestId, status: { in: OPEN }, runAfter: { lte: at } },
        data: { status: 'RUNNING', startedAt: at },
      }),
    );
    const [row] = rows;
    return row ? toGdprRequest(row) : null;
  }

  async complete(
    requestId: string,
    at: Date,
    result: { details: GdprRequestDetails; objectKey?: string; expiresAt?: Date; anonymize?: boolean },
  ): Promise<boolean> {
    const { count } = await runInSystemScope(() =>
      this.system.gdprRequest.updateMany({
        where: { id: requestId, status: 'RUNNING' },
        data: {
          status: 'COMPLETED',
          completedAt: at,
          details: result.details,
          objectKey: result.objectKey ?? null,
          expiresAt: result.expiresAt ?? null,
          ...(result.anonymize ? { requestedById: null } : {}),
        },
      }),
    );
    return count === 1;
  }

  async fail(requestId: string, at: Date, details: GdprRequestDetails): Promise<void> {
    await runInSystemScope(
      () => this.system.$executeRaw`
        UPDATE gdpr_request
           SET status = 'FAILED', completed_at = ${at}, updated_at = ${at},
               details = details || ${JSON.stringify(details)}::jsonb
         WHERE id = ${requestId}::uuid AND status IN ('PENDING', 'RUNNING')`,
    );
  }

  failStale(kind: GdprRequestKind, createdBefore: Date, at: Date): Promise<number> {
    return runInSystemScope(
      () => this.system.$executeRaw`
        UPDATE gdpr_request
           SET status = 'FAILED', completed_at = ${at}, updated_at = ${at},
               details = details || '{"failure": "TIMEOUT"}'::jsonb
         WHERE kind = ${kind}::"GdprRequestKind" AND status IN ('PENDING', 'RUNNING')
           AND created_at < ${createdBefore}`,
    );
  }

  async dueErasures(at: Date, stuckSince: Date, limit: number): Promise<string[]> {
    const rows = await runInSystemScope(() =>
      this.system.gdprRequest.findMany({
        where: {
          kind: 'ERASURE',
          OR: [
            { status: 'PENDING', runAfter: { lte: at } },
            { status: 'RUNNING', startedAt: { lte: stuckSince } },
          ],
        },
        orderBy: { runAfter: 'asc' },
        take: limit,
        select: { id: true },
      }),
    );
    return rows.map((row) => row.id);
  }

  async expiredExports(at: Date, limit: number): Promise<{ id: string; objectKey: string }[]> {
    const rows = await runInSystemScope(() =>
      this.system.gdprRequest.findMany({
        where: { kind: 'EXPORT', objectKey: { not: null }, expiresAt: { lte: at } },
        orderBy: { expiresAt: 'asc' },
        take: limit,
        select: { id: true, objectKey: true },
      }),
    );
    return rows.flatMap((row) => (row.objectKey ? [{ id: row.id, objectKey: row.objectKey }] : []));
  }

  async clearExport(requestId: string): Promise<void> {
    await runInSystemScope(() =>
      this.system.gdprRequest.updateMany({ where: { id: requestId }, data: { objectKey: null } }),
    );
  }
}
