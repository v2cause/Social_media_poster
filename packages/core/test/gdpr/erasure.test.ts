import { describe, expect, it } from 'vitest';

import {
  EraseOrganization,
  ErasureIncompleteError,
  ScheduleErasures,
  type GdprRequest,
  type SocialConnection,
} from '../../src';
import { FakeBillingGateway } from '../in-memory-billing';
import { MemoryEraser, MemoryGdprRequests, RecordingGdprJobs } from '../in-memory-gdpr';
import { MemoryStorage } from '../in-memory-media';
import { MovingClock } from '../in-memory-publish-job';

// Guide step 8.2: 30 days after the deletion the erasure revokes the grants at the platforms,
// deletes the customer at Stripe, removes the objects of the workspaces and the exports and every
// row; a check finds nothing left. The request stays as the record, naming nobody. Everything
// runs again after a failure, and a deletion that was taken back is not erased.

const ORG = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const WS = '0192f000-0000-7000-8000-0000000000a1';
const OTHER_WS = '0192f000-0000-7000-8000-0000000000b1';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const erasureOf = (overrides: Partial<GdprRequest> = {}): GdprRequest => ({
  id: '0192f000-0000-7000-8000-0000000000e9',
  organizationId: ORG,
  kind: 'ERASURE',
  status: 'PENDING',
  requestedById: 'user-1',
  runAfter: new Date(NOW - DAY),
  startedAt: null,
  completedAt: null,
  objectKey: null,
  expiresAt: null,
  details: { workspaceIds: [WS], endsSubscription: true },
  createdAt: new Date(NOW - 31 * DAY),
  ...overrides,
});

const connection = (id: string, sealed: boolean): SocialConnection => ({
  id,
  workspaceId: WS,
  platform: 'LINKEDIN',
  method: 'API',
  status: 'ACTIVE',
  externalUserId: `ext-${id}`,
  displayName: id,
  accessTokenSealed: sealed ? new Uint8Array([1]) : null,
  refreshTokenSealed: null,
  sessionSealed: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scopes: [],
  version: 1,
});

const testbed = (withStripe = true) => {
  const requests = new MemoryGdprRequests();
  const eraser = new MemoryEraser();
  const storage = new MemoryStorage();
  const gateway = new FakeBillingGateway();
  const clock = new MovingClock(NOW);
  const revoked: string[] = [];
  const refusing = new Set<string>();
  eraser.rows.push(
    { table: 'organization', organizationId: ORG },
    { table: 'workspace', organizationId: ORG, workspaceId: WS },
    { table: 'post', workspaceId: WS },
    { table: 'post', workspaceId: WS },
    { table: 'notification', organizationId: ORG },
    { table: 'organization', organizationId: OTHER },
    { table: 'post', workspaceId: OTHER_WS },
  );
  eraser.connectionsOf.set(ORG, [connection('c1', true), connection('c2', true), connection('c3', false)]);
  eraser.customers.set(ORG, 'cus_acme');
  storage.upload(`ws/${WS}/assets/a1/original`, new Uint8Array([1]), 'image/jpeg');
  storage.upload(`ws/${WS}/assets/a1/thumb.webp`, new Uint8Array([1]), 'image/webp');
  storage.upload(`exports/${ORG}/old.zip`, new Uint8Array([1]), 'application/zip');
  storage.upload(`ws/${OTHER_WS}/assets/b1/original`, new Uint8Array([1]), 'image/jpeg');
  const erase = new EraseOrganization({
    requests,
    eraser,
    revoke: (grant) => {
      if (refusing.has(grant.id)) {
        return Promise.reject(new Error('platform refused'));
      }
      revoked.push(grant.id);
      return Promise.resolve();
    },
    billing: withStripe ? gateway : null,
    storage,
    clock,
  });
  return { requests, eraser, storage, gateway, clock, revoked, refusing, erase };
};

describe('the erasure of an organization', () => {
  it('revokes the grants, deletes the customer, the objects and every row, and keeps an anonymous record', async () => {
    const bed = testbed();
    bed.requests.put(erasureOf());
    bed.refusing.add('c2');

    const result = await bed.erase.execute(erasureOf().id);

    expect(result).toEqual({
      outcome: 'erased',
      tokensRevoked: 1,
      tokensFailed: 1,
      objectsDeleted: 3,
      rowsDeleted: 5,
    });
    expect(bed.revoked).toEqual(['c1']);
    expect(bed.gateway.deletedCustomers).toEqual(['cus_acme']);
    expect([...bed.storage.objects.keys()]).toEqual([`ws/${OTHER_WS}/assets/b1/original`]);
    expect(bed.eraser.rows).toEqual([
      { table: 'organization', organizationId: OTHER },
      { table: 'post', workspaceId: OTHER_WS },
    ]);
    expect(bed.requests.get(erasureOf().id)).toMatchObject({
      status: 'COMPLETED',
      requestedById: null,
      completedAt: new Date(NOW),
      details: {
        workspaceIds: [WS],
        tokensRevoked: 1,
        tokensFailed: 1,
        customer: 'deleted',
        objectsDeleted: 3,
        rowsDeleted: 5,
      },
    });
  });

  it('says so when the customer stays because Stripe is not set up', async () => {
    const bed = testbed(false);
    bed.requests.put(erasureOf());

    await bed.erase.execute(erasureOf().id);

    expect(bed.requests.get(erasureOf().id)?.details).toMatchObject({ customer: 'kept' });
  });

  it('fails while rows are left and finishes when it runs again', async () => {
    const bed = testbed();
    bed.requests.put(erasureOf());
    bed.eraser.forget = 'notification';

    await expect(bed.erase.execute(erasureOf().id)).rejects.toEqual(
      new ErasureIncompleteError({ notification: 1 }),
    );
    expect(bed.requests.get(erasureOf().id)?.status).toBe('RUNNING');

    bed.eraser.forget = null;
    await expect(bed.erase.execute(erasureOf().id)).resolves.toMatchObject({ outcome: 'erased' });
    expect(bed.eraser.erasures).toBe(2);
  });

  it('skips an erasure that is not due, was taken back or is no erasure', async () => {
    const bed = testbed();
    bed.requests.put(erasureOf({ id: 'later', runAfter: new Date(NOW + DAY) }));
    bed.requests.put(erasureOf({ id: 'canceled', status: 'CANCELED' }));
    bed.requests.put(erasureOf({ id: 'export', kind: 'EXPORT' }));

    for (const id of ['later', 'canceled', 'export', 'missing']) {
      expect(await bed.erase.execute(id)).toEqual({ outcome: 'skipped' });
    }
    expect(bed.eraser.erasures).toBe(0);
    expect(bed.gateway.deletedCustomers).toEqual([]);
  });
});

describe('the sweep of the erasures', () => {
  it('hands the due erasures to the role gdpr, oldest first, and those whose job was lost', async () => {
    const requests = new MemoryGdprRequests();
    const jobs = new RecordingGdprJobs();
    const clock = new MovingClock(NOW);
    const HOUR = 60 * 60 * 1000;
    requests.put(erasureOf({ id: 'newer', runAfter: new Date(NOW - DAY) }));
    requests.put(erasureOf({ id: 'older', organizationId: OTHER, runAfter: new Date(NOW - 2 * DAY) }));
    requests.put(erasureOf({ id: 'later', runAfter: new Date(NOW + DAY) }));
    requests.put(
      erasureOf({
        id: 'stuck',
        status: 'RUNNING',
        runAfter: new Date(NOW - 3 * DAY),
        startedAt: new Date(NOW - 2 * HOUR),
      }),
    );
    requests.put(
      erasureOf({
        id: 'running',
        status: 'RUNNING',
        runAfter: new Date(NOW - 3 * DAY),
        startedAt: new Date(NOW - HOUR / 2),
      }),
    );

    const result = await new ScheduleErasures({ requests, jobs, clock }).execute();

    expect(result).toEqual({ erasuresQueued: 3 });
    expect(jobs.erasures).toEqual(['stuck', 'older', 'newer']);
  });
});
