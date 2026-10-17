import { VariantNotFoundError } from '../../content/domain/errors';
import type { ContentActor } from '../../content/domain/types';
import {
  applyChange,
  assertCanPublish,
  assertTimeZone,
  checkPublishable,
  publishingScopeOf,
  variantFor,
  type PlanResult,
  type PublishingDependencies,
} from './planning';

// "Jetzt posten" (architecture 7): the variant goes to QUEUED with the current time, and the
// outbox event hands the job to the queue at once instead of waiting for the tick.

export interface PublishNowInput {
  actor: ContentActor;
  variantId: string;
  version: number;
  /** The time zone the calendar shows the post in. */
  timeZone: string;
  socialAccountId?: string;
}

export class PublishNow {
  constructor(private readonly deps: PublishingDependencies) {}

  async execute(input: PublishNowInput): Promise<PlanResult> {
    const { actor } = input;
    assertCanPublish(actor);
    assertTimeZone(input.timeZone);
    const now = this.deps.clock.now();

    return this.deps.unitOfWork.run(publishingScopeOf(actor), async (store) => {
      const variant = await variantFor(
        store,
        actor,
        input,
        ['DRAFT', 'SCHEDULED', 'CANCELED'],
        'QUEUED',
        () => new VariantNotFoundError(),
      );
      const accountId = input.socialAccountId ?? variant.socialAccountId;
      const warnings = await checkPublishable(store, variant, accountId, now);
      await this.deps.posts.assertRoom(actor.organizationId, variant.id, now);
      const scheduleVersion = await applyChange(
        store,
        variant,
        input.version,
        {
          status: 'QUEUED',
          scheduledAt: now,
          scheduledTimezone: input.timeZone,
          socialAccountId: accountId,
          queuedAt: now,
        },
        'now',
      );
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'variant.publish_now',
        targetType: 'PostVariant',
        targetId: variant.id,
        metadata: { platform: variant.platform, socialAccountId: accountId },
      });
      return { status: 'QUEUED', scheduleVersion, scheduledAt: now, warnings };
    });
  }
}
