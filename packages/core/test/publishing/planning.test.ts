import { describe, expect, it } from 'vitest';

import {
  CancelVariant,
  InvalidScheduleTimeError,
  InvalidTransitionError,
  NotPermittedError,
  PublishNow,
  RescheduleVariant,
  ResolveNeedsAttention,
  RetryVariant,
  ScheduleTimeInGapError,
  ScheduleTimeInPastError,
  ScheduleVariant,
  SocialAccountNotReadyError,
  SocialAccountRequiredError,
  VariantNotFoundError,
  VariantNotPublishableError,
  VersionConflictError,
  type ContentActor,
  type DomainError,
} from '../../src';
import { createPublishingTestbed, seedVariant } from '../in-memory-publishing';

// Guide step 4.6: the planning use cases check role, time, account and content, and store the
// status with a new schedule version, the outbox events and an audit entry in one transaction.

const editor: ContentActor = {
  userId: 'u-editor',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  role: 'EDITOR',
};
const viewer: ContentActor = { ...editor, userId: 'u-viewer', role: 'VIEWER' };
const berlin = (localDateTime: string) => ({ localDateTime, timeZone: 'Europe/Berlin' });

const failure = async (promise: Promise<unknown>): Promise<DomainError> =>
  (await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error,
  )) as DomainError;

describe('ScheduleVariant', () => {
  it('plans a draft with a new schedule version, a live event and an audit entry', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed);

    const result = await new ScheduleVariant(bed).execute({
      actor: editor,
      variantId: 'variant-1',
      version: 4,
      at: berlin('2026-10-20T09:30'),
    });

    expect(result).toEqual({
      status: 'SCHEDULED',
      scheduleVersion: 1,
      scheduledAt: new Date('2026-10-20T07:30:00Z'),
      warnings: [],
    });
    expect(bed.unitOfWork.state.variants.get('variant-1')).toMatchObject({
      status: 'SCHEDULED',
      version: 5,
      scheduledTimezone: 'Europe/Berlin',
      socialAccountId: 'account-1',
    });
    expect(bed.unitOfWork.state.outbox).toEqual([
      {
        workspaceId: 'ws-1',
        type: 'variant.status',
        payload: { variantId: 'variant-1', postId: 'post-1', status: 'SCHEDULED', scheduleVersion: 1 },
      },
    ]);
    expect(bed.unitOfWork.state.audit).toEqual([
      expect.objectContaining({ action: 'variant.schedule', targetId: 'variant-1' }),
    ]);
  });

  it('refuses a time in the past and suggests the next minute after a gap', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed);
    const schedule = (localDateTime: string, timeZone = 'Europe/Berlin') =>
      new ScheduleVariant(bed).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        at: { localDateTime, timeZone },
      });

    await expect(schedule('2026-10-16T14:00')).rejects.toBeInstanceOf(ScheduleTimeInPastError);
    const gap = await failure(schedule('2027-03-28T02:30'));
    expect(gap).toBeInstanceOf(ScheduleTimeInGapError);
    expect(gap.params).toEqual({ suggestion: '2027-03-28T03:00', timeZone: 'Europe/Berlin' });
    await expect(schedule('2026-10-20T09:30', 'Atlantis/Capital')).rejects.toBeInstanceOf(
      InvalidScheduleTimeError,
    );
    expect(bed.unitOfWork.state.outbox).toEqual([]);
  });

  it('needs a connected account of the platform with a usable connection', async () => {
    const at = berlin('2026-10-20T09:30');
    const cases = [
      [{ socialAccountId: null }, {}, SocialAccountRequiredError, undefined],
      [{}, { disconnectedAt: new Date('2026-10-01T00:00:00Z') }, SocialAccountNotReadyError, 'DISCONNECTED'],
      [{}, { platform: 'X' as const }, SocialAccountNotReadyError, 'PLATFORM_MISMATCH'],
      [{}, { connectionStatus: 'NEEDS_REAUTH' as const }, SocialAccountNotReadyError, 'NEEDS_REAUTH'],
      [{}, { connectionStatus: 'REVOKED' as const }, SocialAccountNotReadyError, 'REVOKED'],
    ] as const;
    for (const [variant, target, type, reason] of cases) {
      const bed = createPublishingTestbed();
      seedVariant(bed, variant, target);
      const error = await failure(
        new ScheduleVariant(bed).execute({ actor: editor, variantId: 'variant-1', version: 4, at }),
      );
      expect(error).toBeInstanceOf(type);
      expect(error.params?.['reason']).toBe(reason);
    }
  });

  it('refuses content against the rules of the platform, and an empty variant', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed, { platform: 'X', text: 'x'.repeat(300), hashtags: [] }, { platform: 'X' });
    const tooLong = await failure(
      new ScheduleVariant(bed).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        at: berlin('2026-10-20T09:30'),
      }),
    );
    expect(tooLong).toBeInstanceOf(VariantNotPublishableError);
    expect(tooLong.params).toEqual({ issues: ['TEXT_TOO_LONG'] });

    const empty = createPublishingTestbed();
    seedVariant(empty, { text: '  ', hashtags: [] });
    const nothing = await failure(
      new ScheduleVariant(empty).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        at: berlin('2026-10-20T09:30'),
      }),
    );
    expect(nothing.params).toEqual({ issues: ['CONTENT_REQUIRED'] });
  });

  it('checks the images as the platform gets them, after crop and letterbox', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed, { platform: 'INSTAGRAM' }, { platform: 'INSTAGRAM' });
    const wide = { mimeType: 'image/jpeg', width: 3000, height: 1000, crop: null, letterbox: false };
    bed.unitOfWork.state.media.set('variant-1', [wide]);
    const schedule = () =>
      new ScheduleVariant(bed).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        at: berlin('2026-10-20T09:30'),
      });

    expect((await failure(schedule())).params).toEqual({ issues: ['ASPECT_RATIO_OUT_OF_RANGE'] });
    bed.unitOfWork.state.media.set('variant-1', [{ ...wide, letterbox: true }]);
    await expect(schedule()).resolves.toMatchObject({ status: 'SCHEDULED' });
  });

  it('warns when the access runs out before the post goes out', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed, {}, { connectionStatus: 'EXPIRING', accessExpiresAt: new Date('2026-10-18T00:00:00Z') });

    const result = await new ScheduleVariant(bed).execute({
      actor: editor,
      variantId: 'variant-1',
      version: 4,
      at: berlin('2026-10-20T09:30'),
    });
    expect(result.warnings).toEqual(['ACCOUNT_EXPIRING', 'ACCESS_EXPIRES_BEFORE_PUBLISH']);
  });

  it('is for editors and above, on the version the client read, from a draft or a cancellation', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed);
    const at = berlin('2026-10-20T09:30');

    await expect(
      new ScheduleVariant(bed).execute({ actor: viewer, variantId: 'variant-1', version: 4, at }),
    ).rejects.toBeInstanceOf(NotPermittedError);
    await expect(
      new ScheduleVariant(bed).execute({ actor: editor, variantId: 'variant-1', version: 3, at }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const published = createPublishingTestbed();
    seedVariant(published, { status: 'PUBLISHED' });
    const error = await failure(
      new ScheduleVariant(published).execute({ actor: editor, variantId: 'variant-1', version: 4, at }),
    );
    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect(error.params).toEqual({ from: 'PUBLISHED', to: 'SCHEDULED' });
  });
});

describe('RescheduleVariant and CancelVariant', () => {
  it('moves a queued variant to a new time, so its queued job is stale', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed, { status: 'QUEUED', scheduleVersion: 3, queuedAt: new Date('2026-10-16T11:59:50Z') });

    const result = await new RescheduleVariant(bed).execute({
      actor: editor,
      variantId: 'variant-1',
      version: 4,
      at: berlin('2026-10-17T08:00'),
    });

    expect(result).toMatchObject({ status: 'SCHEDULED', scheduleVersion: 4 });
    expect(bed.unitOfWork.state.variants.get('variant-1')?.queuedAt).toBeNull();
    await expect(
      new RescheduleVariant(createPublishingTestbed()).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        at: berlin('2026-10-17T08:00'),
      }),
    ).rejects.toBeInstanceOf(VariantNotFoundError);
  });

  it('cancels a plan, also between two attempts, but not a running publish', async () => {
    for (const status of ['SCHEDULED', 'QUEUED', 'RETRYING'] as const) {
      const bed = createPublishingTestbed();
      seedVariant(bed, { status });
      await expect(
        new CancelVariant(bed).execute({ actor: editor, variantId: 'variant-1', version: 4 }),
      ).resolves.toMatchObject({ status: 'CANCELED', scheduleVersion: 1 });
    }
    const running = createPublishingTestbed();
    seedVariant(running, { status: 'PUBLISHING' });
    await expect(
      new CancelVariant(running).execute({ actor: editor, variantId: 'variant-1', version: 4 }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe('PublishNow, RetryVariant and ResolveNeedsAttention', () => {
  it('queues at once and hands the job to the outbox', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed, { status: 'SCHEDULED', scheduleVersion: 2 });

    const result = await new PublishNow(bed).execute({
      actor: editor,
      variantId: 'variant-1',
      version: 4,
      timeZone: 'Europe/Berlin',
    });

    expect(result).toMatchObject({ status: 'QUEUED', scheduleVersion: 3 });
    expect(bed.unitOfWork.state.variants.get('variant-1')).toMatchObject({
      queuedAt: new Date('2026-10-16T12:00:00Z'),
      scheduledAt: new Date('2026-10-16T12:00:00Z'),
    });
    expect(bed.unitOfWork.state.outbox.map((event) => event.payload)).toEqual([
      { variantId: 'variant-1', postId: 'post-1', status: 'QUEUED', scheduleVersion: 3 },
      { variantId: 'variant-1', scheduleVersion: 3, trigger: 'now' },
    ]);
  });

  it('tries a failed variant again, now or later', async () => {
    const now = createPublishingTestbed();
    seedVariant(now, { status: 'FAILED' });
    await new RetryVariant(now).execute({
      actor: editor,
      variantId: 'variant-1',
      version: 4,
      at: { now: true, timeZone: 'Europe/Berlin' },
    });
    expect(now.unitOfWork.state.outbox.at(-1)?.payload).toMatchObject({ trigger: 'retry' });

    const later = createPublishingTestbed();
    seedVariant(later, { status: 'NEEDS_ATTENTION' });
    await expect(
      new RetryVariant(later).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        at: berlin('2026-10-18T10:00'),
      }),
    ).resolves.toMatchObject({ status: 'SCHEDULED' });
    expect(later.unitOfWork.state.outbox.map((event) => event.type)).toEqual(['variant.status']);
  });

  it('checks again, posts anyway or discards a variant waiting for attention', async () => {
    const outcomes = [];
    for (const action of ['recheck', 'publish_anyway', 'discard'] as const) {
      const bed = createPublishingTestbed();
      seedVariant(bed, { status: 'NEEDS_ATTENTION' });
      const result = await new ResolveNeedsAttention(bed).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        action,
      });
      outcomes.push([action, result.status, bed.unitOfWork.state.outbox.map((event) => event.payload)]);
    }
    expect(outcomes).toEqual([
      [
        'recheck',
        'QUEUED',
        [expect.objectContaining({ status: 'QUEUED' }), expect.objectContaining({ trigger: 'recheck' })],
      ],
      [
        'publish_anyway',
        'QUEUED',
        [expect.objectContaining({ status: 'QUEUED' }), expect.objectContaining({ trigger: 'now' })],
      ],
      ['discard', 'CANCELED', [expect.objectContaining({ status: 'CANCELED' })]],
    ]);
  });

  it('rolls everything back when a step of the transaction fails', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed);
    const failing = {
      ...bed,
      unitOfWork: {
        run: <T>(
          scope: Parameters<typeof bed.unitOfWork.run>[0],
          work: Parameters<typeof bed.unitOfWork.run<T>>[1],
        ) =>
          bed.unitOfWork.run(scope, (store) =>
            work({ ...store, audit: { record: () => Promise.reject(new Error('audit down')) } }),
          ),
      },
    };

    await expect(
      new PublishNow(failing).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        timeZone: 'Europe/Berlin',
      }),
    ).rejects.toThrow('audit down');
    expect(bed.unitOfWork.state.variants.get('variant-1')?.status).toBe('DRAFT');
    expect(bed.unitOfWork.state.outbox).toEqual([]);
  });
});

describe('the posts per month of the plan (guide step 7.4)', () => {
  it('plans a post only while its month has room in the plan, counting each variant once', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed);
    seedVariant(bed, { id: 'variant-2', status: 'SCHEDULED', scheduledAt: new Date('2026-10-25T08:00:00Z') });
    bed.posts.max = 1;

    const refused = failure(
      new ScheduleVariant(bed).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        at: berlin('2026-10-20T09:30'),
      }),
    );
    expect(await refused).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      params: { limit: 'scheduledPostsPerMonth', max: 1 },
    });
    expect(bed.unitOfWork.state.variants.get('variant-1')?.status).toBe('DRAFT');
    // Another month has room, and moving the planned one within October counts it once.
    await expect(
      new ScheduleVariant(bed).execute({
        actor: editor,
        variantId: 'variant-1',
        version: 4,
        at: berlin('2026-11-02T09:30'),
      }),
    ).resolves.toMatchObject({ status: 'SCHEDULED' });
    await expect(
      new RescheduleVariant(bed).execute({
        actor: editor,
        variantId: 'variant-2',
        version: 4,
        at: berlin('2026-10-28T09:30'),
      }),
    ).resolves.toMatchObject({ status: 'SCHEDULED' });
  });

  it('holds for posting now as well', async () => {
    const bed = createPublishingTestbed();
    seedVariant(bed);
    bed.posts.max = 0;

    expect(
      await failure(
        new PublishNow(bed).execute({
          actor: editor,
          variantId: 'variant-1',
          version: 4,
          timeZone: 'Europe/Berlin',
        }),
      ),
    ).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
  });
});
