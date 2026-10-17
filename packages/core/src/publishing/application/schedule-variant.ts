import { VariantNotFoundError } from '../../content/domain/errors';
import type { ContentActor } from '../../content/domain/types';
import {
  applyChange,
  assertCanPublish,
  checkPublishable,
  instantOf,
  publishingScopeOf,
  variantFor,
  type LocalTime,
  type PlanResult,
  type PublishingDependencies,
} from './planning';

// Planning a variant (architecture 7, step 1): checks and the status change with a new schedule
// version in one transaction. The scheduler tick queues it when it is due (guide step 4.7).
// Rescheduling raises the schedule version as well, so a job queued before is stale. The month of
// the new time needs room for one more post in the plan (guide step 7.4).

export interface ScheduleVariantInput {
  actor: ContentActor;
  variantId: string;
  /** The version of the variant the client last read. */
  version: number;
  at: LocalTime;
  /** The account to publish to; without it the variant keeps its account. */
  socialAccountId?: string;
}

async function plan(
  deps: PublishingDependencies,
  input: ScheduleVariantInput,
  from: readonly ('DRAFT' | 'CANCELED' | 'SCHEDULED' | 'QUEUED')[],
  action: 'variant.schedule' | 'variant.reschedule',
): Promise<PlanResult> {
  const { actor } = input;
  assertCanPublish(actor);
  const scheduledAt = instantOf(input.at, deps.clock.now());

  return deps.unitOfWork.run(publishingScopeOf(actor), async (store) => {
    const variant = await variantFor(
      store,
      actor,
      input,
      from,
      'SCHEDULED',
      () => new VariantNotFoundError(),
    );
    const accountId = input.socialAccountId ?? variant.socialAccountId;
    const warnings = await checkPublishable(store, variant, accountId, scheduledAt);
    await deps.posts.assertRoom(actor.organizationId, variant.id, scheduledAt);
    const scheduleVersion = await applyChange(
      store,
      variant,
      input.version,
      {
        status: 'SCHEDULED',
        scheduledAt,
        scheduledTimezone: input.at.timeZone,
        socialAccountId: accountId,
        queuedAt: null,
      },
      null,
    );
    await store.audit.record({
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      action,
      targetType: 'PostVariant',
      targetId: variant.id,
      metadata: {
        platform: variant.platform,
        scheduledAt: scheduledAt.toISOString(),
        timeZone: input.at.timeZone,
        socialAccountId: accountId,
      },
    });
    return { status: 'SCHEDULED', scheduleVersion, scheduledAt, warnings };
  });
}

/** Plans a draft or a canceled variant. */
export class ScheduleVariant {
  constructor(private readonly deps: PublishingDependencies) {}

  execute(input: ScheduleVariantInput): Promise<PlanResult> {
    return plan(this.deps, input, ['DRAFT', 'CANCELED'], 'variant.schedule');
  }
}

/** Moves a planned or queued variant to another time. */
export class RescheduleVariant {
  constructor(private readonly deps: PublishingDependencies) {}

  execute(input: ScheduleVariantInput): Promise<PlanResult> {
    return plan(this.deps, input, ['SCHEDULED', 'QUEUED'], 'variant.reschedule');
  }
}
