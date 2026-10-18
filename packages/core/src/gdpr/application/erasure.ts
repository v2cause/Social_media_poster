import type { BillingGateway } from '../../billing/ports/billing-gateway';
import { workspacePrefix } from '../../media/domain/storage-keys';
import type { StoragePort } from '../../media/ports/storage';
import type { Clock } from '../../shared/ports/clock';
import { exportPrefixOf } from '../domain/request';
import type { GrantRevoker, OrganizationEraser } from '../ports/gdpr-runtime';
import type { GdprJobs, GdprRequestRunner } from '../ports/gdpr-store';

// The erasure of an organization 30 days after its deletion (guide step 8.2, ADR 0037), in this
// order: the grants at the platforms are revoked, the customer at the payment provider is deleted
// (which ends its subscriptions), the objects of its workspaces and exports leave the storage, and
// one transaction deletes every row. A check then looks for anything left. What stays is the
// erasure request, which forgets who asked: the record that the data is gone. A failed step lets
// the job run again; every step can run twice.

/** How many due erasures one sweep hands on. */
const ERASURES_PER_SWEEP = 100;
/**
 * An erasure that runs for longer than this lost its job, for example to a restart, and is handed
 * on again. An erasure is never given up: what failed runs again until nothing is left.
 */
const ERASURE_RETRY_HOURS = 1;
const HOUR_MS = 60 * 60 * 1000;

const workspaceIdsOf = (details: Readonly<Record<string, unknown>>): string[] => {
  const ids = details['workspaceIds'];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
};

export interface ErasureDependencies {
  requests: GdprRequestRunner;
  eraser: OrganizationEraser;
  revoke: GrantRevoker;
  /** Null without Stripe; a customer then stays there, and the record says so. */
  billing: Pick<BillingGateway, 'deleteCustomer'> | null;
  storage: Pick<StoragePort, 'deletePrefix'>;
  clock: Clock;
}

/** Rows were left after the erasure; the job fails and runs again. */
export class ErasureIncompleteError extends Error {
  constructor(readonly leftovers: Readonly<Record<string, number>>) {
    super(`Rows remain after the erasure in ${Object.keys(leftovers).sort().join(', ')}.`);
    this.name = 'ErasureIncompleteError';
  }
}

export interface ErasureResult {
  outcome: 'erased' | 'skipped';
  tokensRevoked?: number;
  tokensFailed?: number;
  objectsDeleted?: number;
  rowsDeleted?: number;
}

export class EraseOrganization {
  constructor(private readonly deps: ErasureDependencies) {}

  async execute(requestId: string): Promise<ErasureResult> {
    const { requests, eraser, storage, clock } = this.deps;
    const request = await requests.claim(requestId, clock.now());
    if (request?.kind !== 'ERASURE') {
      return { outcome: 'skipped' };
    }
    const organizationId = request.organizationId;
    const workspaceIds = workspaceIdsOf(request.details);

    let tokensRevoked = 0;
    let tokensFailed = 0;
    for (const connection of await eraser.connections(organizationId)) {
      if (!connection.accessTokenSealed) {
        continue;
      }
      // The tokens leave with the rows either way; a platform that refuses is only counted.
      try {
        await this.deps.revoke(connection);
        tokensRevoked += 1;
      } catch {
        tokensFailed += 1;
      }
    }

    const customerId = await eraser.billingCustomerOf(organizationId);
    let customer: 'deleted' | 'none' | 'kept' = 'none';
    if (customerId) {
      if (this.deps.billing) {
        await this.deps.billing.deleteCustomer(customerId);
        customer = 'deleted';
      } else {
        customer = 'kept';
      }
    }

    let objectsDeleted = await storage.deletePrefix(exportPrefixOf(organizationId));
    for (const workspaceId of workspaceIds) {
      objectsDeleted += await storage.deletePrefix(workspacePrefix(workspaceId));
    }

    const rows = await eraser.erase(organizationId, workspaceIds, request.id);
    const leftovers = await eraser.leftovers(organizationId, workspaceIds, request.id, customerId);
    if (Object.keys(leftovers).length > 0) {
      throw new ErasureIncompleteError(leftovers);
    }
    const rowsDeleted = Object.values(rows).reduce((sum, count) => sum + count, 0);
    await requests.complete(request.id, clock.now(), {
      anonymize: true,
      details: { workspaceIds, tokensRevoked, tokensFailed, customer, objectsDeleted, rowsDeleted },
    });
    return { outcome: 'erased', tokensRevoked, tokensFailed, objectsDeleted, rowsDeleted };
  }
}

/** Hands the due erasures to the worker role "gdpr", and those whose job was lost (sweep). */
export class ScheduleErasures {
  constructor(
    private readonly deps: {
      requests: Pick<GdprRequestRunner, 'dueErasures'>;
      jobs: Pick<GdprJobs, 'erase'>;
      clock: Clock;
    },
  ) {}

  async execute(): Promise<{ erasuresQueued: number }> {
    const now = this.deps.clock.now();
    const due = await this.deps.requests.dueErasures(
      now,
      new Date(now.getTime() - ERASURE_RETRY_HOURS * HOUR_MS),
      ERASURES_PER_SWEEP,
    );
    for (const requestId of due) {
      await this.deps.jobs.erase(requestId);
    }
    return { erasuresQueued: due.length };
  }
}
