import { describe, expect, it } from 'vitest';

import { CollectPostMetrics, METRICS_LEASE_MS, PlatformError, POLL_RETRY_MS } from '../../src';
import {
  addPublishedVariant,
  createAnalyticsTestbed,
  jobOf,
  metricsOf,
  type AnalyticsTestbed,
} from '../in-memory-analytics';
import { NOW } from '../in-memory-publish-job';

// Guide step 5.2: the collector of post metrics polls the due variants of an account in batches,
// stores snapshots, the latest numbers and the next poll, marks posts deleted on the platform,
// postpones polls after a failure and books the read costs of X.

const HOUR = 60 * 60 * 1000;
const collect = (bed: AnalyticsTestbed, job = jobOf()) => new CollectPostMetrics(bed).execute(job);

describe('CollectPostMetrics', () => {
  it('polls the due variants of the account and stores snapshot, latest numbers and next poll', async () => {
    const bed = createAnalyticsTestbed();
    // Not due yet, another account, a dry run and a draft stay out.
    addPublishedVariant(bed.unitOfWork, 'later', { metricsNextAt: new Date(NOW + HOUR) });
    addPublishedVariant(bed.unitOfWork, 'other-account', { accountId: 'account-2' });
    addPublishedVariant(bed.unitOfWork, 'dry-run', { isDryRun: true });
    addPublishedVariant(bed.unitOfWork, 'draft', { status: 'DRAFT' });

    await expect(collect(bed)).resolves.toEqual({ polled: 2, deleted: 0, postponed: 0, ended: 0 });

    expect(bed.adapter.metricsCalls).toEqual([
      [
        { externalPostId: 'post-variant-1', externalUrl: null },
        { externalPostId: 'post-variant-2', externalUrl: null },
      ],
    ]);
    const { snapshots, latest } = bed.unitOfWork.state;
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual({
      variantId: 'variant-1',
      accountId: 'account-1',
      platform: 'LINKEDIN',
      step: 0,
      metrics: expect.objectContaining({ impressions: 100, reach: 80, likes: 5, clicks: null }) as unknown,
      raw: { impressions: 100 },
      mappingVersion: 3,
      capturedAt: new Date(NOW),
    });
    // likes 5 and comments 1; clicks and saves are not reported.
    expect(latest.get('variant-1')).toMatchObject({ engagements: 6, capturedAt: new Date(NOW) });
    // Published two hours ago: the poll after 24 hours comes next.
    expect(bed.unitOfWork.variant('variant-1')).toMatchObject({
      metricsStep: 1,
      metricsNextAt: new Date(NOW - 2 * HOUR + 24 * HOUR),
    });
    for (const id of ['later', 'other-account', 'dry-run', 'draft']) {
      expect(bed.unitOfWork.variant(id).metricsStep, id).toBe(0);
    }
  });

  it('asks for the rollup of the local days it touched, with the day of a first post', async () => {
    const bed = createAnalyticsTestbed({ variants: 0 });
    // Published at 23:30 in Berlin on October 15, first polled at 14:00 on October 16.
    addPublishedVariant(bed.unitOfWork, 'first-poll', { publishedAt: new Date('2026-10-15T21:30:00Z') });
    addPublishedVariant(bed.unitOfWork, 'later-poll', {
      publishedAt: new Date('2026-10-14T08:00:00Z'),
      metricsStep: 1,
    });

    await collect(bed);
    expect(bed.requested).toEqual([
      { organizationId: 'org-1', workspaceId: 'ws-1', from: '2026-10-15', to: '2026-10-16' },
    ]);

    const idle = createAnalyticsTestbed({ variants: 0 });
    await collect(idle);
    expect(idle.requested).toEqual([]);
  });

  it('still stores its polls when the rollup cannot be asked for', async () => {
    const bed = createAnalyticsTestbed();
    bed.rollups = { request: () => Promise.reject(new Error('Redis is away')) };

    await expect(collect(bed)).resolves.toMatchObject({ polled: 2 });
    expect(bed.unitOfWork.state.snapshots).toHaveLength(2);
    expect(bed.warnings).toEqual(['analytics.rollup_request_failed']);
  });

  it('reads as many posts at once as the platform allows', async () => {
    const bed = createAnalyticsTestbed({ platform: 'X', variants: 150 });

    await expect(collect(bed)).resolves.toMatchObject({ polled: 150 });
    expect(bed.adapter.metricsCalls.map((refs) => refs.length)).toEqual([100, 50]);
  });

  it('skips the polls whose time passed and ends the cascade after the last one', async () => {
    const bed = createAnalyticsTestbed({ variants: 0 });
    addPublishedVariant(bed.unitOfWork, 'late', {
      publishedAt: new Date(NOW - 100 * HOUR),
      metricsNextAt: new Date(NOW - 99 * HOUR),
    });
    addPublishedVariant(bed.unitOfWork, 'last', {
      publishedAt: new Date(NOW - 720 * HOUR),
      metricsNextAt: new Date(NOW - 1),
      metricsStep: 4,
    });

    await collect(bed);
    expect(bed.unitOfWork.variant('late')).toMatchObject({
      metricsStep: 3,
      metricsNextAt: new Date(NOW - 100 * HOUR + 168 * HOUR),
    });
    expect(bed.unitOfWork.variant('last')).toMatchObject({ metricsStep: 5, metricsNextAt: null });
  });

  it('runs the cascade faster with the scale of time-lapse tests', async () => {
    const bed = createAnalyticsTestbed({ variants: 0 });
    bed.cadenceScale = 60;
    addPublishedVariant(bed.unitOfWork, 'fast', { publishedAt: new Date(NOW - 2 * 60 * 1000) });

    await collect(bed);
    expect(bed.unitOfWork.variant('fast').metricsNextAt).toEqual(
      new Date(NOW - 2 * 60 * 1000 + 24 * 60 * 1000),
    );
  });

  it('marks a post the platform no longer knows and asks again for one without an answer', async () => {
    const bed = createAnalyticsTestbed({ variants: 3 });
    bed.adapter.metricsAnswers = [
      [metricsOf('post-variant-1', 50), { kind: 'deleted', externalPostId: 'post-variant-2' }],
    ];

    await expect(collect(bed)).resolves.toEqual({ polled: 1, deleted: 1, postponed: 1, ended: 0 });
    expect(bed.unitOfWork.variant('variant-2')).toMatchObject({
      externalDeletedAt: new Date(NOW),
      metricsNextAt: null,
      metricsStep: 0,
    });
    expect(bed.unitOfWork.state.snapshots.map((snapshot) => snapshot.variantId)).toEqual(['variant-1']);
    expect(bed.unitOfWork.variant('variant-3')).toMatchObject({
      metricsNextAt: new Date(NOW + POLL_RETRY_MS.other),
      metricsStep: 0,
    });
  });

  it('postpones the polls after a rate limit by the wait the platform asks for', async () => {
    const bed = createAnalyticsTestbed();
    bed.adapter.metricsAnswers = [new PlatformError('RATE_LIMITED', 'slow down', { retryAfterMs: 120_000 })];

    await expect(collect(bed)).resolves.toEqual({ polled: 0, deleted: 0, postponed: 2, ended: 0 });
    expect(bed.unitOfWork.variant('variant-1').metricsNextAt).toEqual(new Date(NOW + 120_000));
    expect(bed.unitOfWork.state.snapshots).toEqual([]);
    expect(bed.warnings).toEqual(['analytics.poll_postponed']);
  });

  it('stops the polls of a browser connection at a challenge until the user signs in again', async () => {
    const bed = createAnalyticsTestbed({ platform: 'X', method: 'BROWSER' });
    const seen: unknown[] = [];
    bed.adapter.duringMetrics = (ctx) => {
      seen.push(ctx.browser);
      return Promise.resolve();
    };
    bed.adapter.metricsAnswers = [new PlatformError('CHALLENGE_REQUIRED', 'X asks for a check')];

    await expect(collect(bed)).resolves.toEqual({ polled: 0, deleted: 0, postponed: 2, ended: 0 });
    // The session stays sealed on its way to the browser worker.
    expect(seen).toEqual([{ organizationId: 'org-1', sessionSealed: null }]);
    expect(bed.unitOfWork.state.connections.get('connection-1')).toMatchObject({
      status: 'NEEDS_REAUTH',
      statusReason: 'CHALLENGE_REQUIRED',
    });
    expect(bed.unitOfWork.state.outbox).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-1',
        type: 'notification.requested',
        payload: expect.objectContaining({
          type: 'reauth-required',
          reason: 'CHALLENGE_REQUIRED',
        }) as unknown,
      }),
    ]);
    expect(bed.warnings).toEqual(['analytics.sign_in_required', 'analytics.poll_postponed']);
    expect(bed.adapter.metricsCalls).toHaveLength(1);
  });

  it('asks the user to sign in again when the session of the browser expired, without a second try', async () => {
    const bed = createAnalyticsTestbed({ platform: 'X', method: 'BROWSER' });
    bed.adapter.metricsAnswers = [new PlatformError('AUTH_EXPIRED', 'signed out')];

    await expect(collect(bed)).resolves.toMatchObject({ polled: 0, postponed: 2 });
    expect(bed.adapter.metricsCalls).toHaveLength(1);
    expect(bed.adapter.tokens).not.toContain('refresh:refresh-1');
    expect(bed.unitOfWork.state.connections.get('connection-1')).toMatchObject({
      status: 'NEEDS_REAUTH',
      statusReason: 'SESSION_EXPIRED',
    });
    expect(bed.unitOfWork.state.outbox).toHaveLength(1);
  });

  it('renews a refused token once and polls again', async () => {
    const bed = createAnalyticsTestbed();
    bed.adapter.metricsAnswers = [
      new PlatformError('AUTH_EXPIRED', 'expired'),
      (refs) => refs.map((ref) => metricsOf(ref.externalPostId, 10)),
    ];

    await expect(collect(bed)).resolves.toMatchObject({ polled: 2 });
    expect(bed.adapter.tokens).toEqual(['access-1', 'refresh:refresh-1', 'access-2']);
  });

  it('ends the polls of a disconnected account and waits for a connection that needs a new grant', async () => {
    const disconnected = createAnalyticsTestbed();
    const target = disconnected.unitOfWork.state.targets.get('account-1');
    if (target) {
      target.disconnectedAt = new Date(NOW - HOUR);
    }
    await expect(collect(disconnected)).resolves.toEqual({ polled: 0, deleted: 0, postponed: 0, ended: 2 });
    expect(disconnected.unitOfWork.variant('variant-1').metricsNextAt).toBeNull();

    const reauth = createAnalyticsTestbed();
    const connection = reauth.unitOfWork.state.connections.get('connection-1');
    const reauthTarget = reauth.unitOfWork.state.targets.get('account-1');
    if (connection && reauthTarget) {
      reauthTarget.connection = { ...connection, status: 'NEEDS_REAUTH' };
    }
    await expect(collect(reauth)).resolves.toEqual({ polled: 0, deleted: 0, postponed: 2, ended: 0 });
    expect(reauth.unitOfWork.variant('variant-1').metricsNextAt).toEqual(
      new Date(NOW + POLL_RETRY_MS.access),
    );
    expect(reauth.adapter.metricsCalls).toEqual([]);
  });

  it('books the posts X reads as costs of the poll', async () => {
    const bed = createAnalyticsTestbed({ platform: 'X', variants: 3 });
    bed.adapter.duringMetrics = (ctx, refs) =>
      ctx.costs.record({ operation: 'x.post_read', units: refs.length });

    await collect(bed);
    expect(bed.unitOfWork.state.costs).toEqual([
      {
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        socialAccountId: 'account-1',
        platform: 'X',
        operation: 'x.post_read',
        units: 3,
        costMicros: 15_000,
        sourceType: 'metrics_poll',
        sourceId: 'poll-1',
      },
    ]);
  });

  it('leaves the claim to run out after an error that is no answer of the platform', async () => {
    const bed = createAnalyticsTestbed();
    bed.adapter.metricsAnswers = [new TypeError('fetch failed')];

    await expect(collect(bed)).rejects.toThrow(/fetch failed/);
    expect(bed.unitOfWork.variant('variant-1').metricsNextAt).toEqual(new Date(NOW + METRICS_LEASE_MS));
  });
});
