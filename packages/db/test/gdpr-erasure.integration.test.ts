import { randomUUID } from 'node:crypto';

import type { GdprRequest } from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  PrismaGdprRequestRunner,
  PrismaGdprUnitOfWork,
  PrismaOrganizationEraser,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';
import { createOrganization, fillOrganization, type TestOrganization } from './support/organization-fixtures';
import { inContext } from './support/sql-context';

// Guide step 8.2 on PostgreSQL: an owner marks the organization deleted and takes it back as
// app_user, cancelling the erasure that waits and changing nothing else of it. The worker role
// "gdpr" finds the due erasures and those whose job was lost, deletes every row that names the
// organization or one of its workspaces in one transaction, the webhook events of Stripe of its
// customer included, keeps the erasure request as a record that names nobody and leaves every
// other organization as it was.

const NOW = new Date('2026-11-16T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('the deletion and the erasure of an organization on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let app: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;
  let fixtures: Client | undefined;
  const doomed: TestOrganization = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };
  const other: TestOrganization = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };

  const clients = () => {
    if (!database || !app || !system || !fixtures) {
      throw new Error('not started');
    }
    return { database, app, system, fixtures };
  };

  /** A webhook event of Stripe as the API keeps it: its ids only (ADR 0034). */
  const stripeEvent = (id: string, ids: { subscriptionId: string | null; customerId: string | null }) =>
    clients().fixtures.query(
      `INSERT INTO webhook_event (id, provider, external_id, type, payload)
       VALUES ($1, 'stripe', $2, 'customer.subscription.updated', $3)`,
      [randomUUID(), id, JSON.stringify(ids)],
    );

  beforeAll(async () => {
    database = await startTestDatabase();
    fixtures = await database.connectAs('app_system');
    await createOrganization(fixtures, doomed, {
      name: 'Doomed GmbH',
      slug: 'doomed',
      email: 'owner@doomed.test',
    });
    await createOrganization(fixtures, other, { name: 'Other AG', slug: 'other', email: 'owner@other.test' });
    for (const organization of [doomed, other]) {
      await fillOrganization(
        fixtures,
        organization.organizationId,
        organization.workspaceId,
        organization.ownerId,
      );
    }
    await fixtures.query(
      `INSERT INTO subscription (id, organization_id, plan_key, status, stripe_customer_id, stripe_subscription_id,
                                 updated_at)
       VALUES ($1, $2, 'pro', 'ACTIVE', 'cus_doomed', 'sub_doomed', now()),
              ($3, $4, 'pro', 'ACTIVE', 'cus_other', 'sub_other', now())`,
      [randomUUID(), doomed.organizationId, randomUUID(), other.organizationId],
    );
    app = createPrismaClient(database.url('app_user'));
    system = createSystemPrismaClient(database.url('app_system'));
    // One event names the subscription only, one the customer only, one another customer.
    await stripeEvent('evt_subscription', { subscriptionId: 'sub_doomed', customerId: null });
    await stripeEvent('evt_customer', { subscriptionId: null, customerId: 'cus_doomed' });
    await stripeEvent('evt_other', { subscriptionId: 'sub_other', customerId: 'cus_other' });
  }, 300_000);

  afterAll(async () => {
    await Promise.all([app?.$disconnect(), system?.$disconnect(), fixtures?.end()]);
    await database?.stop();
  });

  const erasureOf = (organization: TestOrganization, overrides: Partial<GdprRequest> = {}): GdprRequest => ({
    id: randomUUID(),
    organizationId: organization.organizationId,
    kind: 'ERASURE',
    status: 'PENDING',
    requestedById: organization.ownerId,
    runAfter: new Date(NOW.getTime() + 30 * DAY),
    startedAt: null,
    completedAt: null,
    objectKey: null,
    expiresAt: null,
    details: { workspaceIds: [organization.workspaceId], endsSubscription: true },
    createdAt: NOW,
    ...overrides,
  });

  it('marks it deleted and restores it as an owner, who can only cancel the erasure that waits', async () => {
    const { app: client, database: db } = clients();
    const unitOfWork = new PrismaGdprUnitOfWork(client);
    const scope = { userId: doomed.ownerId, organizationId: doomed.organizationId };
    const erasure = erasureOf(doomed);

    await expect(
      unitOfWork.run(scope, (store) => store.organizations.find(doomed.organizationId)),
    ).resolves.toEqual({
      id: doomed.organizationId,
      name: 'Doomed GmbH',
      deletedAt: null,
      workspaceIds: [doomed.workspaceId],
      renewingSubscription: true,
    });
    await unitOfWork.run(scope, async (store) => {
      expect(await store.requests.create(erasure)).toBe(true);
      await store.organizations.markDeleted(doomed.organizationId, NOW);
    });
    await expect(
      unitOfWork.run(scope, (store) => store.organizations.find(doomed.organizationId)),
    ).resolves.toMatchObject({ deletedAt: NOW });
    await expect(
      unitOfWork.run(scope, (store) => store.requests.find(doomed.organizationId, erasure.id)),
    ).resolves.toMatchObject({ details: { workspaceIds: [doomed.workspaceId], endsSubscription: true } });

    const appClient = await db.connectAs('app_user');
    try {
      const asOwner = <T>(fn: () => Promise<T>) =>
        inContext(appClient, { userId: doomed.ownerId, organizationId: doomed.organizationId }, fn);
      await expect(
        asOwner(() =>
          appClient.query(`UPDATE gdpr_request SET object_key = 'x' WHERE id = $1`, [erasure.id]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asOwner(() =>
          appClient.query(`UPDATE gdpr_request SET status = 'COMPLETED' WHERE id = $1`, [erasure.id]),
        ),
      ).rejects.toThrow(/row-level security/);
      // Another organization does not even see it.
      const foreign = await inContext(
        appClient,
        { userId: other.ownerId, organizationId: other.organizationId },
        () => appClient.query(`UPDATE gdpr_request SET status = 'CANCELED' WHERE id = $1`, [erasure.id]),
      );
      expect(foreign.rowCount).toBe(0);
    } finally {
      await appClient.end();
    }

    await expect(
      unitOfWork.run(scope, (store) => store.requests.cancel(doomed.organizationId, erasure.id, NOW)),
    ).resolves.toBe(true);
    await expect(
      unitOfWork.run(scope, (store) => store.requests.cancel(doomed.organizationId, erasure.id, NOW)),
    ).resolves.toBe(false);
    await unitOfWork.run(scope, (store) => store.organizations.restore(doomed.organizationId));
    await expect(
      unitOfWork.run(scope, (store) => store.organizations.find(doomed.organizationId)),
    ).resolves.toMatchObject({ deletedAt: null });
    await expect(
      unitOfWork.run(scope, (store) => store.requests.find(doomed.organizationId, erasure.id)),
    ).resolves.toMatchObject({ status: 'CANCELED', completedAt: NOW });
  });

  it('finds the due erasures and those whose job was lost, and completes one naming nobody', async () => {
    const { system: client, fixtures: sql } = clients();
    const runner = new PrismaGdprRequestRunner(client);
    const insert = (id: string, kind: string, status: string, runAfter: Date, startedAt: Date | null) =>
      sql.query(
        `INSERT INTO gdpr_request (id, organization_id, kind, status, requested_by_id, run_after, started_at,
                                   updated_at)
         VALUES ($1, $2, $3::"GdprRequestKind", $4::"GdprRequestStatus", $5, $6, $7, now())`,
        // Every request its own organization: one open request per kind and organization.
        [id, randomUUID(), kind, status, other.ownerId, runAfter, startedAt],
      );
    const due = randomUUID();
    const stuck = randomUUID();
    const running = randomUUID();
    const later = randomUUID();
    const exportDue = randomUUID();
    await insert(due, 'ERASURE', 'PENDING', new Date(NOW.getTime() - DAY), null);
    await insert(
      stuck,
      'ERASURE',
      'RUNNING',
      new Date(NOW.getTime() - 2 * DAY),
      new Date(NOW.getTime() - 2 * HOUR),
    );
    await insert(
      running,
      'ERASURE',
      'RUNNING',
      new Date(NOW.getTime() - 2 * DAY),
      new Date(NOW.getTime() - HOUR / 6),
    );
    await insert(later, 'ERASURE', 'PENDING', new Date(NOW.getTime() + DAY), null);
    await insert(exportDue, 'EXPORT', 'PENDING', new Date(NOW.getTime() - DAY), null);

    const found = await runner.dueErasures(NOW, new Date(NOW.getTime() - HOUR), 100);
    const inserted: string[] = [due, stuck, running, later, exportDue];
    expect(found.filter((id) => inserted.includes(id))).toEqual([stuck, due]);

    await expect(runner.claim(due, NOW)).resolves.toMatchObject({ status: 'RUNNING' });
    await expect(
      runner.complete(due, NOW, { anonymize: true, details: { workspaceIds: ['ws-1'], rowsDeleted: 3 } }),
    ).resolves.toBe(true);
    const { rows } = await sql.query<{ status: string; requested_by_id: string | null; details: unknown }>(
      `SELECT status, requested_by_id, details FROM gdpr_request WHERE id = $1`,
      [due],
    );
    expect(rows[0]).toEqual({
      status: 'COMPLETED',
      requested_by_id: null,
      details: { workspaceIds: ['ws-1'], rowsDeleted: 3 },
    });
  });

  it('erases every row of the organization and of its workspaces and nothing of another', async () => {
    const { system: client, fixtures: sql } = clients();
    const eraser = new PrismaOrganizationEraser(client);
    const keep = erasureOf(doomed, { status: 'RUNNING', runAfter: NOW });
    await sql.query(
      `INSERT INTO gdpr_request (id, organization_id, kind, status, requested_by_id, run_after, details, updated_at)
       VALUES ($1, $2, 'ERASURE', 'RUNNING', $3, $4, $5, now())`,
      [keep.id, doomed.organizationId, doomed.ownerId, NOW, JSON.stringify(keep.details)],
    );
    const untouched = await eraser.leftovers(other.organizationId, [other.workspaceId], randomUUID(), null);
    expect(untouched).toMatchObject({
      organization: 1,
      workspace: 1,
      post: 1,
      social_connection: 1,
      webhook_event: 1,
    });

    const connections = await eraser.connections(doomed.organizationId);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.accessTokenSealed).not.toBeNull();
    await expect(eraser.billingCustomerOf(doomed.organizationId)).resolves.toBe('cus_doomed');

    const counts = await eraser.erase(doomed.organizationId, [doomed.workspaceId], keep.id);

    expect(counts).toMatchObject({
      organization: 1,
      workspace: 1,
      workspace_settings: 1,
      membership: 1,
      subscription: 1,
      post: 1,
      post_media: 1,
      media_asset: 1,
      social_connection: 1,
      social_account: 1,
      notification: 1,
      feature_flag: 1,
      audit_log: 1,
      // The export of the fixtures and the erasure canceled above; the running erasure stays.
      gdpr_request: 2,
      webhook_event: 2,
    });
    await expect(
      eraser.leftovers(doomed.organizationId, [doomed.workspaceId], keep.id, null),
    ).resolves.toEqual({});
    const count = async (query: string, values: unknown[]) =>
      (await sql.query<{ count: number }>(query, values)).rows[0]?.count;
    await expect(
      count(`SELECT count(*)::int AS count FROM gdpr_request WHERE id = $1`, [keep.id]),
    ).resolves.toBe(1);
    await expect(
      count(`SELECT count(*)::int AS count FROM webhook_event WHERE external_id = ANY($1)`, [
        ['evt_subscription', 'evt_customer', 'evt_other'],
      ]),
    ).resolves.toBe(1);
    // An event that comes after the subscription went is found by the customer the erasure deleted.
    await stripeEvent('evt_late', { subscriptionId: 'sub_doomed', customerId: 'cus_doomed' });
    await expect(
      eraser.leftovers(doomed.organizationId, [doomed.workspaceId], keep.id, 'cus_doomed'),
    ).resolves.toEqual({ webhook_event: 1 });
    await sql.query(`DELETE FROM webhook_event WHERE external_id = 'evt_late'`);
    // The members keep their own accounts; only their membership went.
    await expect(
      count(`SELECT count(*)::int AS count FROM users WHERE id = $1`, [doomed.ownerId]),
    ).resolves.toBe(1);
    await expect(
      eraser.leftovers(other.organizationId, [other.workspaceId], randomUUID(), null),
    ).resolves.toEqual(untouched);

    // A second run finds nothing to erase.
    await expect(eraser.erase(doomed.organizationId, [doomed.workspaceId], keep.id)).resolves.toEqual({});
    await expect(eraser.connections(doomed.organizationId)).resolves.toEqual([]);
    await expect(eraser.billingCustomerOf(doomed.organizationId)).resolves.toBeNull();
  });
});
