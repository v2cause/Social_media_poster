import { VariantNotFoundError } from '../../content/domain/errors';
import type { ContentActor } from '../../content/domain/types';
import {
  applyChange,
  assertCanPublish,
  assertTimeZone,
  checkPublishable,
  instantOf,
  publishingScopeOf,
  variantFor,
  type LocalTime,
  type PlanResult,
  type PublishingDependencies,
} from './planning';

// "Erneut" for a failed variant or one waiting for attention (architecture 7.2): planned for a
// new time, or queued at once. A former unclear attempt is reconciled before anything goes out
// (guide step 4.8), so trying again never posts twice.

export interface RetryVariantInput {
  actor: ContentActor;
  variantId: string;
  version: number;
  /** A new time, or now. */
  at: LocalTime | { now: true; timeZone: string };
}

export class RetryVariant {
  constructor(private readonly deps: PublishingDependencies) {}

  async execute(input: RetryVariantInput): Promise<PlanResult> {
    const { actor, at } = input;
    assertCanPublish(actor);
    const now = this.deps.clock.now();
    const immediately = 'now' in at;
    if (immediately) {
      assertTimeZone(at.timeZone);
    }
    const publishAt = 'now' in at ? now : instantOf(at, now);
    const to = immediately ? 'QUEUED' : 'SCHEDULED';

    return this.deps.unitOfWork.run(publishingScopeOf(actor), async (store) => {
      const variant = await variantFor(
        store,
        actor,
        input,
        ['FAILED', 'NEEDS_ATTENTION'],
        to,
        () => new VariantNotFoundError(),
      );
      const warnings = await checkPublishable(store, variant, variant.socialAccountId, publishAt);
      await this.deps.posts.assertRoom(actor.organizationId, variant.id, publishAt);
      const scheduleVersion = await applyChange(
        store,
        variant,
        input.version,
        {
          status: to,
          scheduledAt: publishAt,
          scheduledTimezone: at.timeZone,
          socialAccountId: variant.socialAccountId,
          queuedAt: immediately ? now : null,
        },
        immediately ? 'retry' : null,
      );
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'variant.retry',
        targetType: 'PostVariant',
        targetId: variant.id,
        metadata: { platform: variant.platform, from: variant.status, scheduledAt: publishAt.toISOString() },
      });
      return { status: to, scheduleVersion, scheduledAt: publishAt, warnings };
    });
  }
}
