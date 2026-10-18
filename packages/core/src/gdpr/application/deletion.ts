import { NotPermittedError } from '../../shared/domain/errors';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import { OrganizationNotFoundError } from '../../tenancy/domain/errors';
import type { OrganizationActor } from '../../tenancy/domain/types';
import {
  ErasureNotPendingError,
  OrganizationDeletionPendingError,
  OrganizationNameMismatchError,
} from '../domain/errors';
import { erasureDateOf, type GdprRequest } from '../domain/request';
import type { GdprNotifier } from '../ports/gdpr-runtime';
import type { DeletionBilling, GdprScope, GdprUnitOfWork } from '../ports/gdpr-store';

// The deletion of an organization by an owner (guide step 8.2, ADR 0037): from that moment nobody
// works in it, and 30 days later the erasure removes it for good, unless an owner takes the
// deletion back. The owner confirms with the name of the organization. A paid subscription that
// renews ends with its period; taking the deletion back lets it renew again. What follows the
// commit, the end of the subscription and the notice to the owners, may fail without undoing it.

export interface DeletionDependencies {
  unitOfWork: GdprUnitOfWork;
  /** Null without Stripe. */
  billing: DeletionBilling | null;
  notifier: Pick<GdprNotifier, 'erasureScheduled'>;
  clock: Clock;
  ids: IdGenerator;
  /** Reports a step after the commit that failed; never with secrets. */
  warn: (message: string, fields: Record<string, unknown>) => void;
}

const assertOwner = (actor: OrganizationActor): void => {
  if (actor.role !== 'OWNER') {
    throw new NotPermittedError();
  }
};

const scopeOf = (actor: OrganizationActor): GdprScope => ({
  userId: actor.userId,
  organizationId: actor.organizationId,
});

async function afterCommit(
  deps: Pick<DeletionDependencies, 'warn'>,
  step: string,
  organizationId: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    deps.warn(`Could not ${step}.`, { organizationId, error });
  }
}

export class RequestOrganizationErasure {
  constructor(private readonly deps: DeletionDependencies) {}

  async execute(input: { actor: OrganizationActor; confirmName: string }): Promise<GdprRequest> {
    const { actor } = input;
    assertOwner(actor);
    const now = this.deps.clock.now();
    const request = await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const organization = await store.organizations.find(actor.organizationId);
      if (!organization) {
        throw new OrganizationNotFoundError();
      }
      if (organization.deletedAt) {
        throw new OrganizationDeletionPendingError();
      }
      if (input.confirmName.trim() !== organization.name.trim()) {
        throw new OrganizationNameMismatchError();
      }
      const created: GdprRequest = {
        id: this.deps.ids.newId(),
        organizationId: actor.organizationId,
        kind: 'ERASURE',
        status: 'PENDING',
        requestedById: actor.userId,
        runAfter: erasureDateOf(now),
        startedAt: null,
        completedAt: null,
        objectKey: null,
        expiresAt: null,
        // The workspaces outlive their rows in the request, so that the erasure finds their objects
        // and the check finds rows that name them; the subscription is let renew again on undo.
        details: {
          workspaceIds: organization.workspaceIds,
          endsSubscription: organization.renewingSubscription,
        },
        createdAt: now,
      };
      if (!(await store.requests.create(created))) {
        throw new OrganizationDeletionPendingError();
      }
      await store.organizations.markDeleted(actor.organizationId, now);
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'organization.delete_requested',
        targetType: 'Organization',
        targetId: actor.organizationId,
        metadata: { eraseAfter: created.runAfter.toISOString() },
      });
      return created;
    });
    const billing = this.deps.billing;
    if (billing && request.details['endsSubscription'] === true) {
      await afterCommit(
        this.deps,
        'end the subscription of a deleted organization',
        actor.organizationId,
        () => billing.endWithPeriod(actor.organizationId, true),
      );
    }
    await afterCommit(this.deps, 'tell the owners about the erasure', actor.organizationId, () =>
      this.deps.notifier.erasureScheduled({
        requestId: request.id,
        organizationId: actor.organizationId,
        eraseAfter: request.runAfter,
      }),
    );
    return request;
  }
}

export class CancelOrganizationErasure {
  constructor(private readonly deps: Omit<DeletionDependencies, 'notifier' | 'ids'>) {}

  /** Takes the deletion back while the erasure waits; the organization works as before. */
  async execute(actor: OrganizationActor): Promise<void> {
    assertOwner(actor);
    const now = this.deps.clock.now();
    const canceled = await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const open = await store.requests.findOpen(actor.organizationId, 'ERASURE');
      if (open?.status !== 'PENDING' || !(await store.requests.cancel(actor.organizationId, open.id, now))) {
        throw new ErasureNotPendingError();
      }
      await store.organizations.restore(actor.organizationId);
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'organization.delete_canceled',
        targetType: 'Organization',
        targetId: actor.organizationId,
      });
      return open;
    });
    const billing = this.deps.billing;
    if (billing && canceled.details['endsSubscription'] === true) {
      await afterCommit(this.deps, 'let the subscription renew again', actor.organizationId, () =>
        billing.endWithPeriod(actor.organizationId, false),
      );
    }
  }
}
