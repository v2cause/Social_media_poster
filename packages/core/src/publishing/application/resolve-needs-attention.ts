import { VariantNotFoundError } from '../../content/domain/errors';
import type { ContentActor } from '../../content/domain/types';
import {
  applyChange,
  assertCanPublish,
  checkPublishable,
  publishingScopeOf,
  variantFor,
  type PlanResult,
  type PublishingDependencies,
} from './planning';

// The choices for a variant whose publish ended unclear (architecture 7.1):
// - recheck ("erneut prüfen"): the job only reconciles again and posts nothing;
// - publish_anyway ("trotzdem posten"): the job reconciles and posts if it finds nothing;
// - discard ("verwerfen"): the variant is canceled.

export const NEEDS_ATTENTION_ACTIONS = ['recheck', 'publish_anyway', 'discard'] as const;
export type NeedsAttentionAction = (typeof NEEDS_ATTENTION_ACTIONS)[number];

export interface ResolveNeedsAttentionInput {
  actor: ContentActor;
  variantId: string;
  version: number;
  action: NeedsAttentionAction;
}

export class ResolveNeedsAttention {
  constructor(private readonly deps: PublishingDependencies) {}

  async execute(input: ResolveNeedsAttentionInput): Promise<PlanResult> {
    const { actor, action } = input;
    assertCanPublish(actor);
    const now = this.deps.clock.now();
    const to = action === 'discard' ? 'CANCELED' : 'QUEUED';

    return this.deps.unitOfWork.run(publishingScopeOf(actor), async (store) => {
      const variant = await variantFor(
        store,
        actor,
        input,
        ['NEEDS_ATTENTION'],
        to,
        () => new VariantNotFoundError(),
      );
      const warnings =
        action === 'publish_anyway'
          ? await checkPublishable(store, variant, variant.socialAccountId, now)
          : [];
      const scheduleVersion = await applyChange(
        store,
        variant,
        input.version,
        {
          status: to,
          scheduledAt: variant.scheduledAt,
          scheduledTimezone: variant.scheduledTimezone,
          socialAccountId: variant.socialAccountId,
          queuedAt: to === 'QUEUED' ? now : null,
        },
        action === 'recheck' ? 'recheck' : action === 'publish_anyway' ? 'now' : null,
      );
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'variant.resolve',
        targetType: 'PostVariant',
        targetId: variant.id,
        metadata: { platform: variant.platform, choice: action },
      });
      return { status: to, scheduleVersion, scheduledAt: variant.scheduledAt, warnings };
    });
  }
}
