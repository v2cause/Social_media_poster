import { describe, expect, it } from 'vitest';

import {
  CancelOrganizationErasure,
  ErasureNotPendingError,
  NotPermittedError,
  OrganizationDeletionPendingError,
  OrganizationNameMismatchError,
  RequestOrganizationErasure,
  type OrganizationActor,
} from '../../src';
import {
  MemoryGdprRequests,
  MemoryGdprUnitOfWork,
  MemoryOrganizations,
  RecordingDeletionBilling,
  RecordingGdprNotifier,
} from '../in-memory-gdpr';
import { MovingClock } from '../in-memory-publish-job';
import { SequentialIds } from '../in-memory-tenancy';

// Guide step 8.2: an owner deletes the organization by typing its name; nobody works in it from
// then on, and the erasure follows in 30 days. A paid subscription that renews ends with its
// period, and the owners hear when the data goes. Until then an owner can take it back, and the
// subscription renews again. Nobody but an owner may do either.

const ORG = '0192f000-0000-7000-8000-000000000001';
const WS = '0192f000-0000-7000-8000-0000000000a1';
const owner: OrganizationActor = { userId: 'user-1', organizationId: ORG, role: 'OWNER' };
const admin: OrganizationActor = { userId: 'user-2', organizationId: ORG, role: 'ADMIN' };
const NOW = Date.parse('2026-10-17T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const testbed = (renewingSubscription = true) => {
  const requests = new MemoryGdprRequests();
  const organizations = new MemoryOrganizations();
  organizations.put({
    id: ORG,
    name: 'Acme GmbH',
    deletedAt: null,
    workspaceIds: [WS],
    renewingSubscription,
  });
  const unitOfWork = new MemoryGdprUnitOfWork(requests, organizations);
  const billing = new RecordingDeletionBilling();
  const notifier = new RecordingGdprNotifier();
  const clock = new MovingClock(NOW);
  const warnings: string[] = [];
  const deps = {
    unitOfWork,
    billing,
    notifier,
    clock,
    ids: new SequentialIds(),
    warn: (message: string) => {
      warnings.push(message);
    },
  };
  return {
    requests,
    organizations,
    billing,
    notifier,
    clock,
    warnings,
    remove: new RequestOrganizationErasure(deps),
    restore: new CancelOrganizationErasure(deps),
  };
};

describe('deleting an organization', () => {
  it('marks it deleted, schedules the erasure in 30 days, ends the subscription and tells the owners', async () => {
    const bed = testbed();

    const erasure = await bed.remove.execute({ actor: owner, confirmName: ' Acme GmbH ' });

    expect(erasure).toMatchObject({
      kind: 'ERASURE',
      status: 'PENDING',
      requestedById: 'user-1',
      runAfter: new Date(NOW + 30 * DAY),
      details: { workspaceIds: [WS], endsSubscription: true },
    });
    expect((await bed.organizations.find(ORG))?.deletedAt).toEqual(new Date(NOW));
    expect(bed.billing.calls).toEqual([{ organizationId: ORG, end: true }]);
    expect(bed.notifier.scheduled).toEqual([
      { requestId: erasure.id, organizationId: ORG, eraseAfter: new Date(NOW + 30 * DAY) },
    ]);
    expect(bed.requests.audit).toEqual([
      {
        organizationId: ORG,
        action: 'organization.delete_requested',
        targetType: 'Organization',
        targetId: ORG,
        metadata: { eraseAfter: new Date(NOW + 30 * DAY).toISOString() },
      },
    ]);
  });

  it('leaves a subscription alone that does not renew', async () => {
    const bed = testbed(false);

    const erasure = await bed.remove.execute({ actor: owner, confirmName: 'Acme GmbH' });

    expect(erasure.details).toMatchObject({ endsSubscription: false });
    expect(bed.billing.calls).toEqual([]);
  });

  it('refuses a wrong name, a second deletion and members who are no owner', async () => {
    const bed = testbed();

    await expect(bed.remove.execute({ actor: owner, confirmName: 'Acme' })).rejects.toBeInstanceOf(
      OrganizationNameMismatchError,
    );
    await expect(bed.remove.execute({ actor: admin, confirmName: 'Acme GmbH' })).rejects.toBeInstanceOf(
      NotPermittedError,
    );
    expect((await bed.organizations.find(ORG))?.deletedAt).toBeNull();

    await bed.remove.execute({ actor: owner, confirmName: 'Acme GmbH' });
    await expect(bed.remove.execute({ actor: owner, confirmName: 'Acme GmbH' })).rejects.toBeInstanceOf(
      OrganizationDeletionPendingError,
    );
    expect([...bed.requests.rows.values()]).toHaveLength(1);
  });

  it('keeps the deletion when the notice or the subscription fail after the commit', async () => {
    const bed = testbed();
    bed.notifier.failNext = true;

    await bed.remove.execute({ actor: owner, confirmName: 'Acme GmbH' });

    expect((await bed.organizations.find(ORG))?.deletedAt).not.toBeNull();
    expect(bed.warnings).toEqual(['Could not tell the owners about the erasure.']);
  });
});

describe('taking the deletion back', () => {
  it('cancels the erasure, restores the organization and lets the subscription renew again', async () => {
    const bed = testbed();
    const erasure = await bed.remove.execute({ actor: owner, confirmName: 'Acme GmbH' });
    bed.clock.advance(5 * DAY);

    await bed.restore.execute(owner);

    expect(bed.requests.get(erasure.id)).toMatchObject({
      status: 'CANCELED',
      completedAt: new Date(NOW + 5 * DAY),
    });
    expect((await bed.organizations.find(ORG))?.deletedAt).toBeNull();
    expect(bed.billing.calls).toEqual([
      { organizationId: ORG, end: true },
      { organizationId: ORG, end: false },
    ]);
    expect(bed.requests.audit.map((entry) => entry.action)).toEqual([
      'organization.delete_requested',
      'organization.delete_canceled',
    ]);
    // A new deletion is possible again.
    await expect(bed.remove.execute({ actor: owner, confirmName: 'Acme GmbH' })).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  it('does not let a subscription renew that the owners had ended before', async () => {
    const bed = testbed(false);
    await bed.remove.execute({ actor: owner, confirmName: 'Acme GmbH' });

    await bed.restore.execute(owner);

    expect(bed.billing.calls).toEqual([]);
  });

  it('refuses when no erasure waits, when it runs already and for members who are no owner', async () => {
    const bed = testbed();
    await expect(bed.restore.execute(owner)).rejects.toBeInstanceOf(ErasureNotPendingError);

    const erasure = await bed.remove.execute({ actor: owner, confirmName: 'Acme GmbH' });
    await expect(bed.restore.execute(admin)).rejects.toBeInstanceOf(NotPermittedError);
    bed.clock.advance(31 * DAY);
    await bed.requests.claim(erasure.id, bed.clock.now());

    await expect(bed.restore.execute(owner)).rejects.toBeInstanceOf(ErasureNotPendingError);
    expect((await bed.organizations.find(ORG))?.deletedAt).not.toBeNull();
  });
});
