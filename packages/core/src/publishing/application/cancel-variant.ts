import { VariantNotFoundError } from '../../content/domain/errors';
import type { ContentActor } from '../../content/domain/types';
import {
  applyChange,
  assertCanPublish,
  publishingScopeOf,
  variantFor,
  type PlanResult,
  type PublishingDependencies,
} from './planning';

// Cancels a plan (architecture 7.2). A job queued for it finds a newer schedule version and
// ends without action; between two attempts the next one does not start.

export class CancelVariant {
  constructor(private readonly deps: PublishingDependencies) {}

  async execute(input: { actor: ContentActor; variantId: string; version: number }): Promise<PlanResult> {
    const { actor } = input;
    assertCanPublish(actor);
    return this.deps.unitOfWork.run(publishingScopeOf(actor), async (store) => {
      const variant = await variantFor(
        store,
        actor,
        input,
        ['SCHEDULED', 'QUEUED', 'RETRYING'],
        'CANCELED',
        () => new VariantNotFoundError(),
      );
      const scheduleVersion = await applyChange(
        store,
        variant,
        input.version,
        {
          status: 'CANCELED',
          scheduledAt: variant.scheduledAt,
          scheduledTimezone: variant.scheduledTimezone,
          socialAccountId: variant.socialAccountId,
          queuedAt: null,
        },
        null,
      );
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'variant.cancel',
        targetType: 'PostVariant',
        targetId: variant.id,
        metadata: { platform: variant.platform, from: variant.status },
      });
      return { status: 'CANCELED', scheduleVersion, scheduledAt: variant.scheduledAt, warnings: [] };
    });
  }
}
