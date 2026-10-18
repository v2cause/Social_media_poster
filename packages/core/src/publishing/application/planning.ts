import type { PostLimits } from '../../billing/application/plan-limits';
import {
  composePostText,
  planRendition,
  renditionProfileFor,
  validatePost,
  type MediaItem,
  type Platform,
} from '@smp/platform-rules';

import { VersionConflictError } from '../../content/domain/errors';
import type { ContentActor, VariantStatus } from '../../content/domain/types';
import { NotPermittedError } from '../../shared/domain/errors';
import type { OutboxEventInput } from '../../shared/domain/outbox';
import type { Clock } from '../../shared/ports/clock';
import {
  InvalidScheduleTimeError,
  InvalidTransitionError,
  ScheduleTimeInGapError,
  ScheduleTimeInPastError,
  SocialAccountNotReadyError,
  SocialAccountRequiredError,
  VariantNotPublishableError,
} from '../domain/errors';
import { isKnownTimeZone, resolveLocalTime } from '../domain/local-time';
import { canPublish, isConnectionUsable, type ScheduleWarning } from '../domain/rules';
import { canTransition } from '../domain/variant-state-machine';
import type {
  PublishingScope,
  PublishingStore,
  PublishingUnitOfWork,
  SchedulableVariant,
  ScheduleChange,
  VariantMediaSource,
} from '../ports/publishing-store';

// What the planning use cases share (guide step 4.6): the permission, the instant of a local
// time, the checks of account and content, and the status change with its outbox events and
// audit entry in the transaction of the change.

export interface PublishingDependencies {
  unitOfWork: PublishingUnitOfWork;
  clock: Clock;
  /** The posts per month the plan of the organization allows (guide step 7.4). */
  posts: PostLimits;
}

/** A local date and time (YYYY-MM-DDTHH:mm) in an IANA time zone, as the user picked it. */
export interface LocalTime {
  localDateTime: string;
  timeZone: string;
}

/** The outcome of a planning use case. */
export interface PlanResult {
  status: VariantStatus;
  scheduleVersion: number;
  scheduledAt: Date | null;
  warnings: ScheduleWarning[];
}

export const publishingScopeOf = (actor: ContentActor): PublishingScope => ({
  userId: actor.userId,
  organizationId: actor.organizationId,
  workspaceId: actor.workspaceId,
});

/** The second line behind the permission guard of the API. */
export function assertCanPublish(actor: ContentActor): void {
  if (!canPublish(actor.role)) {
    throw new NotPermittedError();
  }
}

/** The instant of a plan: an existing local time in the future. */
export function instantOf(at: LocalTime, now: Date): Date {
  const resolved = resolveLocalTime(at.localDateTime, at.timeZone);
  if (resolved.kind === 'invalid') {
    throw new InvalidScheduleTimeError();
  }
  if (resolved.kind === 'gap') {
    throw new ScheduleTimeInGapError(resolved.next.localDateTime, at.timeZone);
  }
  if (resolved.instant.getTime() <= now.getTime()) {
    throw new ScheduleTimeInPastError();
  }
  return resolved.instant;
}

export function assertTimeZone(timeZone: string): void {
  if (!isKnownTimeZone(timeZone)) {
    throw new InvalidScheduleTimeError();
  }
}

/** Loads the variant and checks the version and that the use case may move it from its status. */
export async function variantFor(
  store: PublishingStore,
  actor: ContentActor,
  input: { variantId: string; version: number },
  from: readonly VariantStatus[],
  to: VariantStatus,
  notFound: () => Error,
): Promise<SchedulableVariant> {
  const variant = await store.variants.find(actor.workspaceId, input.variantId);
  if (!variant) {
    throw notFound();
  }
  if (variant.version !== input.version) {
    throw new VersionConflictError();
  }
  if (!from.includes(variant.status) || !canTransition(variant.status, to)) {
    throw new InvalidTransitionError(variant.status, to);
  }
  return variant;
}

/**
 * The images as the platform gets them: the size of the rendition after crop and letterbox. An
 * image without a valid rendition keeps the size of its region, so the ratio check reports it.
 */
export const mediaItemsFor = (platform: Platform, sources: readonly VariantMediaSource[]): MediaItem[] =>
  sources.map((source) => {
    const plan = planRendition(
      source,
      { crop: source.crop, letterbox: source.letterbox },
      renditionProfileFor(platform),
    );
    const size = plan.ok
      ? { width: plan.plan.width, height: plan.plan.height }
      : { width: source.crop?.width ?? source.width, height: source.crop?.height ?? source.height };
    return { kind: 'image', mimeType: source.mimeType, ...size };
  });

/**
 * Checks what a publish needs: a connected account of the platform with a usable connection, and
 * content within the rules of the platform. Returns the warnings of the plan.
 */
export async function checkPublishable(
  store: PublishingStore,
  variant: SchedulableVariant,
  accountId: string | null,
  publishAt: Date,
): Promise<ScheduleWarning[]> {
  if (accountId === null) {
    throw new SocialAccountRequiredError();
  }
  const target = await store.targets.find(variant.workspaceId, accountId);
  if (!target || target.disconnectedAt !== null) {
    throw new SocialAccountNotReadyError('DISCONNECTED');
  }
  if (target.platform !== variant.platform) {
    throw new SocialAccountNotReadyError('PLATFORM_MISMATCH');
  }
  if (!isConnectionUsable(target.connectionStatus)) {
    throw new SocialAccountNotReadyError(
      target.connectionStatus === 'PAUSED' || target.connectionStatus === 'REVOKED'
        ? target.connectionStatus
        : 'NEEDS_REAUTH',
    );
  }

  const media = mediaItemsFor(variant.platform, await store.media.sourcesOf(variant.workspaceId, variant.id));
  const issues: string[] = validatePost({
    platform: variant.platform,
    text: variant.text,
    hashtags: variant.hashtags,
    firstComment: variant.firstComment,
    media,
  }).map((issue) => issue.code);
  if (composePostText(variant.text, variant.hashtags).length === 0 && media.length === 0) {
    issues.unshift('CONTENT_REQUIRED');
  }
  if (issues.length > 0) {
    throw new VariantNotPublishableError([...new Set(issues)]);
  }

  const warnings: ScheduleWarning[] = [];
  if (target.connectionStatus === 'EXPIRING') {
    warnings.push('ACCOUNT_EXPIRING');
  }
  if (target.accessExpiresAt !== null && target.accessExpiresAt <= publishAt) {
    warnings.push('ACCESS_EXPIRES_BEFORE_PUBLISH');
  }
  return warnings;
}

/**
 * Checks that the month of `at` has room for one more post in the plan of the organization. Under
 * its lock, held until the transaction ends, parallel plannings in its workspaces count one after
 * the other and together stay within the plan (guide steps 7.4 and 8.4).
 */
export async function assertPostRoom(
  posts: PostLimits,
  store: PublishingStore,
  organizationId: string,
  variantId: string,
  at: Date,
): Promise<void> {
  await store.variants.lockPostLimit(organizationId);
  // Counted after the lock: a planning that held it before is committed by now.
  await posts.assertRoom(organizationId, variantId, at);
}

/**
 * Stores the change with a version check and writes the live event of the new status, plus the
 * publish job where the variant goes to QUEUED.
 */
export async function applyChange(
  store: PublishingStore,
  variant: SchedulableVariant,
  version: number,
  change: ScheduleChange,
  publishTrigger: 'now' | 'retry' | 'recheck' | null,
): Promise<number> {
  const result = await store.variants.change(variant.workspaceId, variant.id, version, change);
  if (!result) {
    throw new VersionConflictError();
  }
  const events: OutboxEventInput[] = [
    {
      type: 'variant.status',
      payload: {
        variantId: variant.id,
        postId: variant.postId,
        status: change.status,
        scheduleVersion: result.scheduleVersion,
      },
    },
  ];
  if (publishTrigger !== null) {
    events.push({
      type: 'publish.requested',
      payload: { variantId: variant.id, scheduleVersion: result.scheduleVersion, trigger: publishTrigger },
    });
  }
  for (const event of events) {
    await store.outbox.add(variant.workspaceId, event);
  }
  return result.scheduleVersion;
}
