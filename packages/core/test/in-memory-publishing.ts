import type {
  AuditEntry,
  OutboxEventInput,
  PublishingDependencies,
  PublishingScope,
  PublishingStore,
  PublishingTarget,
  PublishingUnitOfWork,
  SchedulableVariant,
  VariantMediaSource,
} from '../src';
import { PlanLimitReachedError, type PostLimits } from '../src';
import { fixedClock, ScopeViolation } from './in-memory-content';

// In-memory adapters for the planning use cases: a unit of work that hides other workspaces and
// rolls back on errors, with variants, targets, media, outbox and audit.

interface State {
  variants: Map<string, SchedulableVariant & { queuedAt: Date | null }>;
  targets: Map<string, PublishingTarget & { workspaceId: string }>;
  media: Map<string, VariantMediaSource[]>;
  outbox: (OutboxEventInput & { workspaceId: string })[];
  audit: AuditEntry[];
}

export class InMemoryPublishing implements PublishingUnitOfWork {
  state: State = { variants: new Map(), targets: new Map(), media: new Map(), outbox: [], audit: [] };

  async run<T>(scope: PublishingScope, work: (store: PublishingStore) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  private storeFor(scope: PublishingScope): PublishingStore {
    const state = (): State => this.state;
    const assertScope = (workspaceId: string): void => {
      if (workspaceId !== scope.workspaceId) {
        throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
      }
    };
    return {
      variants: {
        find(workspaceId, variantId) {
          assertScope(workspaceId);
          const variant = state().variants.get(variantId);
          return Promise.resolve(variant?.workspaceId === workspaceId ? variant : null);
        },
        change(workspaceId, variantId, version, change) {
          assertScope(workspaceId);
          const variant = state().variants.get(variantId);
          if (variant?.workspaceId !== workspaceId || variant.version !== version) {
            return Promise.resolve(null);
          }
          const scheduleVersion = variant.scheduleVersion + 1;
          state().variants.set(variantId, {
            ...variant,
            ...change,
            version: variant.version + 1,
            scheduleVersion,
          });
          return Promise.resolve({ scheduleVersion });
        },
      },
      targets: {
        find(workspaceId, accountId) {
          assertScope(workspaceId);
          const target = state().targets.get(accountId);
          return Promise.resolve(target?.workspaceId === workspaceId ? target : null);
        },
      },
      media: {
        sourcesOf(workspaceId, variantId) {
          assertScope(workspaceId);
          return Promise.resolve(state().media.get(variantId) ?? []);
        },
      },
      outbox: {
        add(workspaceId, event) {
          assertScope(workspaceId);
          state().outbox.push({ ...event, workspaceId });
          return Promise.resolve();
        },
      },
      audit: {
        record(entry) {
          state().audit.push(entry);
          return Promise.resolve();
        },
      },
    };
  }
}

/** The posts per month of the plan over the variants of the in-memory store. */
export class MemoryPostLimits implements PostLimits {
  max = Number.POSITIVE_INFINITY;

  constructor(private readonly unitOfWork: InMemoryPublishing) {}

  assertRoom(_organizationId: string, variantId: string, at: Date): Promise<void> {
    const month = at.toISOString().slice(0, 7);
    const used = [...this.unitOfWork.state.variants.values()].filter(
      (variant) =>
        variant.id !== variantId &&
        ['SCHEDULED', 'QUEUED', 'PUBLISHING', 'RETRYING', 'PUBLISHED', 'NEEDS_ATTENTION'].includes(
          variant.status,
        ) &&
        variant.scheduledAt?.toISOString().slice(0, 7) === month,
    ).length;
    if (used + 1 > this.max) {
      return Promise.reject(new PlanLimitReachedError('scheduledPostsPerMonth', this.max));
    }
    return Promise.resolve();
  }
}

export interface PublishingTestbed extends PublishingDependencies {
  unitOfWork: InMemoryPublishing;
  posts: MemoryPostLimits;
}

/** Now is 2026-10-16T12:00:00Z, 14:00 in Berlin. */
export function createPublishingTestbed(): PublishingTestbed {
  const unitOfWork = new InMemoryPublishing();
  return { unitOfWork, clock: fixedClock('2026-10-16T12:00:00Z'), posts: new MemoryPostLimits(unitOfWork) };
}

/** A LinkedIn draft of workspace ws-1 with a text and an active account. */
export function seedVariant(
  bed: PublishingTestbed,
  overrides: Partial<SchedulableVariant & { queuedAt: Date | null }> = {},
  target: Partial<PublishingTarget> = {},
): SchedulableVariant & { queuedAt: Date | null } {
  const variant = {
    id: 'variant-1',
    workspaceId: 'ws-1',
    postId: 'post-1',
    platform: 'LINKEDIN' as const,
    status: 'DRAFT' as const,
    version: 4,
    scheduleVersion: 0,
    socialAccountId: 'account-1',
    text: 'Wir suchen Verstärkung im Kundendienst.',
    hashtags: ['Karriere'],
    firstComment: null,
    scheduledAt: null,
    scheduledTimezone: null,
    queuedAt: null,
    ...overrides,
  };
  bed.unitOfWork.state.variants.set(variant.id, variant);
  bed.unitOfWork.state.targets.set('account-1', {
    id: 'account-1',
    workspaceId: 'ws-1',
    platform: 'LINKEDIN',
    disconnectedAt: null,
    connectionStatus: 'ACTIVE',
    accessExpiresAt: new Date('2026-12-15T12:00:00Z'),
    ...target,
  });
  return variant;
}
