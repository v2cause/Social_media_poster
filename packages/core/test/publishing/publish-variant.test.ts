import { describe, expect, it } from 'vitest';

import { accountSecretAad, connectionSecretAad, PlatformError, PublishVariant } from '../../src';
import {
  createPublishJobTestbed,
  jobOf,
  NOW,
  sealed,
  type PublishJobTestbed,
} from '../in-memory-publish-job';

// Guide step 4.8: the publish job claims the variant with a lease, logs the attempt, reconciles
// after an unclear attempt, renews the token under the lock of its connection, checks the content
// again, sends it or only records it in a dry run, and reacts to errors as in architecture 7.1.

const publish = (bed: PublishJobTestbed, job = jobOf()) => new PublishVariant(bed).execute(job);

/** An attempt of an earlier run, as a crashed or unclear run left it behind. */
const leaveAttempt = (
  bed: PublishJobTestbed,
  outcome: 'STARTED' | 'UNKNOWN',
  scheduleVersion = 3,
  startedAt = new Date(NOW - 10 * 60 * 1000),
) => {
  bed.unitOfWork.state.attempts.push({
    id: `earlier-${outcome}-${String(scheduleVersion)}`,
    workspaceId: 'ws-1',
    variantId: 'variant-1',
    scheduleVersion,
    trigger: 'schedule',
    leaseOwner: 'worker-old:1',
    startedAt,
    attemptNumber: 1,
    outcome,
    errorCode: null,
    errorMessage: null,
    externalPostId: null,
    meta: {},
    finishedAt: null,
  });
};

const found = {
  externalPostId: 'post-earlier',
  externalUrl: 'https://platform.example/posts/post-earlier',
  publishedAt: new Date(NOW - 9 * 60 * 1000),
};

describe('PublishVariant', () => {
  it('publishes a queued variant and records attempt, events and the first metrics poll', async () => {
    const bed = createPublishJobTestbed();

    await expect(publish(bed)).resolves.toEqual({ kind: 'published', reconciled: false, dryRun: false });

    expect(bed.adapter.requests).toEqual([
      {
        variantId: 'variant-1',
        text: 'Wir suchen Verstärkung im Kundendienst.\n\n#Karriere',
        firstComment: null,
        linkUrl: null,
        media: [],
        contentHash: expect.any(String) as string,
      },
    ]);
    expect(bed.adapter.tokens).toEqual(['access-1']);
    expect(bed.adapter.calls.reconcile).toBe(0);
    expect(bed.unitOfWork.variant()).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: 'post-1',
      externalUrl: 'https://platform.example/posts/post-1',
      publishedAt: new Date(NOW),
      metricsNextAt: new Date(NOW + 60 * 60 * 1000),
      contentHash: bed.adapter.requests[0]?.contentHash,
      isDryRun: false,
      leaseOwner: null,
      leaseUntil: null,
    });
    expect(bed.unitOfWork.attempts()).toEqual([
      expect.objectContaining({
        id: 'attempt-1',
        scheduleVersion: 3,
        attemptNumber: 1,
        trigger: 'schedule',
        leaseOwner: 'worker-a:1',
        outcome: 'PUBLISHED',
        externalPostId: 'post-1',
        finishedAt: new Date(NOW),
      }),
    ]);
    expect(bed.unitOfWork.statuses()).toEqual(['PUBLISHING', 'PUBLISHED']);
    expect(bed.unitOfWork.state.outbox[0]).toMatchObject({
      workspaceId: 'ws-1',
      payload: { variantId: 'variant-1', postId: 'post-1', scheduleVersion: 3 },
    });
  });

  it('gives the same content the same hash in every run', async () => {
    const first = createPublishJobTestbed();
    const second = createPublishJobTestbed();
    second.unitOfWork.variant().hashtags = ['Karriere'];

    await publish(first);
    await publish(second);

    expect(first.adapter.requests[0]?.contentHash).toBe(second.adapter.requests[0]?.contentHash);
  });

  describe('ends without action', () => {
    it('for a job of an older schedule version or a variant that moved on', async () => {
      const bed = createPublishJobTestbed();
      await expect(publish(bed, jobOf({ scheduleVersion: 2 }))).resolves.toEqual({
        kind: 'skipped',
        reason: 'STALE',
      });

      for (const status of [
        'DRAFT',
        'SCHEDULED',
        'PUBLISHED',
        'FAILED',
        'CANCELED',
        'NEEDS_ATTENTION',
      ] as const) {
        bed.unitOfWork.variant().status = status;
        await expect(publish(bed)).resolves.toEqual({ kind: 'skipped', reason: 'STALE' });
      }
      expect(bed.adapter.calls).toEqual({ publish: 0, reconcile: 0, refresh: 0 });
      expect(bed.unitOfWork.attempts()).toEqual([]);
      expect(bed.unitOfWork.state.outbox).toEqual([]);
    });

    it('for a variant that does not exist', async () => {
      const bed = createPublishJobTestbed();
      bed.unitOfWork.state.variants.clear();

      await expect(publish(bed)).resolves.toEqual({ kind: 'skipped', reason: 'NOT_FOUND' });
    });
  });

  it('waits for the live lease of another run', async () => {
    const bed = createPublishJobTestbed({
      variant: { status: 'PUBLISHING', leaseOwner: 'worker-b:9', leaseUntil: new Date(NOW + 90_000) },
    });

    await expect(publish(bed)).resolves.toEqual({ kind: 'busy', retryInMs: 91_000 });
    expect(bed.unitOfWork.attempts()).toEqual([]);
    expect(bed.adapter.calls.publish).toBe(0);
  });

  describe('after an unclear attempt', () => {
    const takenOver = {
      status: 'PUBLISHING' as const,
      leaseOwner: 'worker-old:1',
      leaseUntil: new Date(NOW - 1),
    };

    it('finds the post of a run that stopped after sending, and does not send again', async () => {
      const bed = createPublishJobTestbed({ variant: takenOver });
      leaveAttempt(bed, 'UNKNOWN');
      bed.adapter.reconcileAnswers = [found];

      await expect(publish(bed, jobOf({ trigger: 'sweep' }))).resolves.toEqual({
        kind: 'published',
        reconciled: true,
        dryRun: false,
      });

      expect(bed.adapter.calls).toEqual({ publish: 0, reconcile: 1, refresh: 0 });
      expect(bed.adapter.queries).toEqual([
        {
          text: 'Wir suchen Verstärkung im Kundendienst.\n\n#Karriere',
          since: new Date(NOW - 11 * 60 * 1000),
          contentHash: expect.any(String) as string,
        },
      ]);
      expect(bed.unitOfWork.variant()).toMatchObject({ status: 'PUBLISHED', externalPostId: 'post-earlier' });
      expect(bed.unitOfWork.attempts().map((attempt) => attempt.outcome)).toEqual(['UNKNOWN', 'RECONCILED']);
      // A takeover does not announce PUBLISHING again.
      expect(bed.unitOfWork.statuses()).toEqual(['PUBLISHED']);
    });

    it('leaves the decision to the user when the post of such a run cannot be found', async () => {
      const bed = createPublishJobTestbed({ variant: takenOver });
      leaveAttempt(bed, 'UNKNOWN');

      await expect(publish(bed)).resolves.toEqual({ kind: 'needs_attention', code: 'OUTCOME_UNKNOWN' });

      expect(bed.adapter.calls.publish).toBe(0);
      expect(bed.unitOfWork.variant()).toMatchObject({
        status: 'NEEDS_ATTENTION',
        failureCode: 'OUTCOME_UNKNOWN',
      });
      expect(bed.unitOfWork.attempts()[1]).toMatchObject({ outcome: 'FAILED', errorCode: 'OUTCOME_UNKNOWN' });
    });

    it('sends when the run stopped before it sent anything and the post is not there', async () => {
      const bed = createPublishJobTestbed({ variant: takenOver });
      leaveAttempt(bed, 'STARTED');

      await expect(publish(bed)).resolves.toMatchObject({ kind: 'published', reconciled: false });
      expect(bed.adapter.calls).toMatchObject({ reconcile: 1, publish: 1 });
      expect(bed.unitOfWork.attempts()[1]).toMatchObject({ attemptNumber: 2, outcome: 'PUBLISHED' });
    });

    it('sends after "trotzdem posten", when the unclear attempt belongs to an earlier version', async () => {
      const bed = createPublishJobTestbed();
      leaveAttempt(bed, 'UNKNOWN', 2);

      await expect(publish(bed, jobOf({ trigger: 'now' }))).resolves.toMatchObject({ kind: 'published' });
      expect(bed.adapter.calls).toMatchObject({ reconcile: 1, publish: 1 });
    });

    it('only reconciles on "erneut prüfen"', async () => {
      const bed = createPublishJobTestbed();
      leaveAttempt(bed, 'UNKNOWN', 2);

      await expect(publish(bed, jobOf({ trigger: 'recheck' }))).resolves.toEqual({
        kind: 'needs_attention',
        code: 'OUTCOME_UNKNOWN',
      });
      bed.unitOfWork.variant().status = 'QUEUED';
      bed.adapter.reconcileAnswers = [found];
      await expect(publish(bed, jobOf({ trigger: 'recheck' }))).resolves.toMatchObject({ reconciled: true });
      expect(bed.adapter.calls.publish).toBe(0);
    });
  });

  describe('a missed window', () => {
    const late = { scheduledAt: new Date(NOW - 7 * 60 * 60 * 1000) };

    it('fails a variant whose job comes more than 6 h late', async () => {
      const bed = createPublishJobTestbed({ variant: late });

      await expect(publish(bed, jobOf({ trigger: 'sweep' }))).resolves.toEqual({
        kind: 'failed',
        code: 'MISSED_WINDOW',
      });
      expect(bed.unitOfWork.variant()).toMatchObject({ status: 'FAILED', failureCode: 'MISSED_WINDOW' });
      expect(bed.unitOfWork.statuses()).toEqual(['FAILED']);
      expect(bed.unitOfWork.attempts()).toEqual([]);
    });

    it('still posts when the workspace says so, or the user asked for it', async () => {
      const anyway = createPublishJobTestbed({ variant: { ...late, missedWindowBehavior: 'POST_ANYWAY' } });
      await expect(publish(anyway, jobOf({ trigger: 'sweep' }))).resolves.toMatchObject({
        kind: 'published',
      });

      const now = createPublishJobTestbed({ variant: late });
      await expect(publish(now, jobOf({ trigger: 'now' }))).resolves.toMatchObject({ kind: 'published' });
    });
  });

  describe('the error table of architecture 7.1', () => {
    it('waits out a rate limit without using up an attempt', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('RATE_LIMITED', 'slow down', { retryAfterMs: 2_000 })];

      await expect(publish(bed)).resolves.toEqual({
        kind: 'retry',
        code: 'RATE_LIMITED',
        retryAfterMs: 2_000,
        countsAsAttempt: false,
      });
      expect(bed.unitOfWork.variant()).toMatchObject({
        status: 'RETRYING',
        failureCode: 'RATE_LIMITED',
        lastError: 'slow down',
        leaseOwner: null,
      });
      expect(bed.unitOfWork.attempts()[0]).toMatchObject({ outcome: 'RETRY', errorCode: 'RATE_LIMITED' });
      expect(bed.unitOfWork.statuses()).toEqual(['PUBLISHING', 'RETRYING']);
    });

    it('retries a transient error with backoff, and fails it on the last attempt', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('TRANSIENT', 'HTTP 503', { status: 503 })];

      await expect(publish(bed)).resolves.toEqual({
        kind: 'retry',
        code: 'TRANSIENT',
        retryAfterMs: null,
        countsAsAttempt: true,
      });
      await expect(publish(bed, jobOf({ lastAttempt: true }))).resolves.toEqual({
        kind: 'failed',
        code: 'TRANSIENT',
      });
      expect(bed.unitOfWork.variant()).toMatchObject({ status: 'FAILED', failureCode: 'TRANSIENT' });
      expect(bed.unitOfWork.attempts().map((attempt) => [attempt.attemptNumber, attempt.outcome])).toEqual([
        [1, 'RETRY'],
        [2, 'FAILED'],
      ]);
    });

    it.each([
      ['VALIDATION_REJECTED', 'VALIDATION_REJECTED'],
      ['PERMISSION_DENIED', 'PERMISSION_DENIED'],
      ['DUPLICATE', 'DUPLICATE'],
      ['SPEND_CAP_REACHED', 'SPEND_CAP'],
    ] as const)('fails at once on %s', async (code, failureCode) => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError(code, `${code} from the platform`)];

      await expect(publish(bed)).resolves.toEqual({ kind: 'failed', code: failureCode });
      expect(bed.unitOfWork.variant()).toMatchObject({ status: 'FAILED', failureCode });
      expect(bed.unitOfWork.attempts()[0]).toMatchObject({ outcome: 'FAILED', errorCode: code });
    });

    it('refreshes a refused token once, under the lock, and sends again', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('AUTH_EXPIRED', 'HTTP 401'), found];

      await expect(publish(bed)).resolves.toMatchObject({ kind: 'published' });

      expect(bed.locked).toEqual(['connection-1']);
      expect(bed.adapter.tokens).toEqual(['access-1', 'refresh:refresh-1', 'access-2']);
      const aad = (field: 'access_token' | 'refresh_token') =>
        connectionSecretAad('ws-1', 'connection-1', field);
      expect(bed.unitOfWork.connection()).toMatchObject({
        status: 'ACTIVE',
        version: 3,
        accessTokenSealed: sealed('access-2', aad('access_token')),
        refreshTokenSealed: sealed('refresh-2', aad('refresh_token')),
        accessTokenExpiresAt: new Date(NOW + 2 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(NOW),
        scopes: ['w_member_social'],
      });
    });

    it('asks for a new grant when the token is refused after its refresh', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('AUTH_EXPIRED', 'HTTP 401')];

      await expect(publish(bed)).resolves.toEqual({ kind: 'failed', code: 'REAUTH_REQUIRED' });

      expect(bed.adapter.calls).toMatchObject({ publish: 2, refresh: 1 });
      expect(bed.unitOfWork.connection()).toMatchObject({
        status: 'NEEDS_REAUTH',
        statusReason: 'REFRESH_FAILED',
      });
      expect(bed.unitOfWork.variant()).toMatchObject({ status: 'FAILED', failureCode: 'REAUTH_REQUIRED' });
      expect(bed.unitOfWork.attempts()[0]).toMatchObject({ outcome: 'FAILED', errorCode: 'AUTH_EXPIRED' });
    });

    it('asks for a new grant when the platform refuses the refresh', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('AUTH_EXPIRED', 'HTTP 401')];
      bed.adapter.refreshAnswers = [new PlatformError('AUTH_EXPIRED', 'refresh refused')];

      await expect(publish(bed)).resolves.toEqual({ kind: 'failed', code: 'REAUTH_REQUIRED' });
      expect(bed.adapter.calls).toMatchObject({ publish: 1, refresh: 1 });
      expect(bed.unitOfWork.connection().status).toBe('NEEDS_REAUTH');
    });

    it('asks for a new grant when the platform cannot renew a refused token', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('AUTH_EXPIRED', 'HTTP 401')];
      bed.adapter.refreshAnswers = [{ status: 'not_supported' }];

      await expect(publish(bed)).resolves.toEqual({ kind: 'failed', code: 'REAUTH_REQUIRED' });
      expect(bed.unitOfWork.connection()).toMatchObject({ statusReason: 'REFRESH_NOT_SUPPORTED' });
    });

    it('reconciles after an unknown outcome and finds the post', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('OUTCOME_UNKNOWN', 'timeout after sending')];
      bed.adapter.reconcileAnswers = [found];

      await expect(publish(bed)).resolves.toEqual({ kind: 'published', reconciled: true, dryRun: false });
      expect(bed.unitOfWork.attempts()[0]).toMatchObject({
        outcome: 'RECONCILED',
        externalPostId: 'post-earlier',
      });
      expect(bed.adapter.queries[0]?.since).toEqual(new Date(NOW - 60_000));
    });

    it('leaves an unknown outcome to the user when the post cannot be found', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('OUTCOME_UNKNOWN', 'timeout after sending')];

      await expect(publish(bed)).resolves.toEqual({ kind: 'needs_attention', code: 'OUTCOME_UNKNOWN' });
      expect(bed.unitOfWork.variant()).toMatchObject({
        status: 'NEEDS_ATTENTION',
        lastError: 'timeout after sending',
      });
      // The attempt stays unclear, so "erneut prüfen" and "trotzdem posten" reconcile first.
      expect(bed.unitOfWork.attempts()[0]).toMatchObject({
        outcome: 'UNKNOWN',
        errorCode: 'OUTCOME_UNKNOWN',
      });
    });

    it('tries the reconcile again later when it fails after an unknown outcome', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new Error('unexpected answer')];
      bed.adapter.reconcileAnswers = [new PlatformError('TRANSIENT', 'HTTP 502')];

      await expect(publish(bed)).resolves.toEqual({
        kind: 'retry',
        code: 'OUTCOME_UNKNOWN',
        retryAfterMs: null,
        countsAsAttempt: true,
      });
      expect(bed.unitOfWork.attempts()[0]).toMatchObject({ outcome: 'UNKNOWN' });
      expect(bed.warnings).toEqual(['publish.answer_unreadable']);

      // The next run of the same version reconciles first and never sends again.
      bed.adapter.reconcileAnswers = [null];
      await expect(publish(bed)).resolves.toEqual({ kind: 'needs_attention', code: 'OUTCOME_UNKNOWN' });
      expect(bed.adapter.calls.publish).toBe(1);
    });

    it('stops a browser run that meets a challenge, and asks for a new login', async () => {
      const bed = createPublishJobTestbed({ platform: 'X', method: 'BROWSER' });
      bed.adapter.publishAnswers = [new PlatformError('CHALLENGE_REQUIRED', 'captcha')];

      await expect(publish(bed)).resolves.toEqual({ kind: 'needs_attention', code: 'CHALLENGE_REQUIRED' });
      expect(bed.unitOfWork.connection()).toMatchObject({
        status: 'NEEDS_REAUTH',
        statusReason: 'CHALLENGE_REQUIRED',
      });
    });

    it('retries an unexpected error before sending, and fails it on the last attempt', async () => {
      const bed = createPublishJobTestbed();
      bed.storage.signedGetUrl = () => Promise.reject(new TypeError('storage down'));
      bed.unitOfWork.state.media.set('variant-1', [
        { assetId: 'asset-1', crop: null, letterbox: false, altText: null },
      ]);
      bed.unitOfWork.setRendition('asset-1', 'linkedin_image', 'full', {
        storageKey: 'ws/ws-1/assets/asset-1/linkedin_image-full.jpg',
        mimeType: 'image/jpeg',
        width: 1200,
        height: 1200,
        sizeBytes: 300_000,
      });

      await expect(publish(bed)).resolves.toMatchObject({
        kind: 'retry',
        code: 'INTERNAL',
        countsAsAttempt: true,
      });
      expect(bed.unitOfWork.variant()).toMatchObject({ status: 'RETRYING', lastError: 'TypeError' });
      expect(bed.warnings).toEqual(['publish.unexpected_error']);
      await expect(publish(bed, jobOf({ lastAttempt: true }))).resolves.toEqual({
        kind: 'failed',
        code: 'INTERNAL',
      });
      expect(bed.adapter.calls.publish).toBe(0);
    });
  });

  describe('the token', () => {
    it('is renewed under the lock before the platform is called when it runs out soon', async () => {
      const bed = createPublishJobTestbed();
      bed.unitOfWork.connection().accessTokenExpiresAt = new Date(NOW + 2 * 60 * 1000);

      await publish(bed);

      expect(bed.locked).toEqual(['connection-1']);
      expect(bed.adapter.tokens).toEqual(['refresh:refresh-1', 'access-2']);
    });

    it('is not renewed again when another run renewed it while this one waited for the lock', async () => {
      const bed = createPublishJobTestbed();
      bed.unitOfWork.connection().accessTokenExpiresAt = new Date(NOW + 2 * 60 * 1000);
      bed.locks.withConnectionLock = (_id, work) => {
        const connection = bed.unitOfWork.connection();
        connection.version += 1;
        connection.accessTokenSealed = sealed(
          'access-other',
          connectionSecretAad('ws-1', 'connection-1', 'access_token'),
        );
        connection.accessTokenExpiresAt = new Date(NOW + 2 * 60 * 60 * 1000);
        return work();
      };

      await publish(bed);

      expect(bed.adapter.calls.refresh).toBe(0);
      expect(bed.adapter.tokens).toEqual(['access-other']);
    });

    it('of the account is used where it has one, for example a Facebook page', async () => {
      const bed = createPublishJobTestbed({ platform: 'FACEBOOK' });
      const account = bed.unitOfWork.state.accounts.get('account-1');
      if (account) {
        account.accessTokenSealed = sealed(
          'page-token',
          accountSecretAad('ws-1', 'connection-1', 'account-1'),
        );
      }

      await publish(bed);

      expect(bed.adapter.tokens).toEqual(['page-token']);
    });
  });

  describe('a dry run', () => {
    it('of the workspace renews the token, sends nothing and records the payload without signed URLs', async () => {
      const bed = createPublishJobTestbed({ variant: { dryRun: true } });
      bed.unitOfWork.connection().accessTokenExpiresAt = new Date(NOW + 60_000);
      bed.unitOfWork.state.media.set('variant-1', [
        { assetId: 'asset-1', crop: null, letterbox: false, altText: 'Das Team' },
      ]);
      bed.unitOfWork.setRendition('asset-1', 'linkedin_image', 'full', {
        storageKey: 'ws/ws-1/assets/asset-1/linkedin_image-full.jpg',
        mimeType: 'image/jpeg',
        width: 1200,
        height: 1200,
        sizeBytes: 300_000,
      });

      await expect(publish(bed)).resolves.toEqual({ kind: 'published', reconciled: false, dryRun: true });

      // The token runs out within a minute: renewed like in a real run (architecture 16).
      expect(bed.adapter.calls).toEqual({ publish: 0, reconcile: 0, refresh: 1 });
      expect(bed.unitOfWork.variant()).toMatchObject({
        status: 'PUBLISHED',
        isDryRun: true,
        externalPostId: null,
        metricsNextAt: null,
        publishedAt: new Date(NOW),
      });
      const [attempt] = bed.unitOfWork.attempts();
      expect(attempt?.outcome).toBe('DRY_RUN');
      expect(attempt?.meta).toEqual({
        payload: {
          text: 'Wir suchen Verstärkung im Kundendienst.\n\n#Karriere',
          firstComment: null,
          linkUrl: null,
          media: [
            {
              assetId: 'asset-1',
              profile: 'linkedin_image',
              mimeType: 'image/jpeg',
              width: 1200,
              height: 1200,
              sizeBytes: 300_000,
              altText: 'Das Team',
            },
          ],
          contentHash: expect.any(String) as string,
        },
      });
      expect(JSON.stringify(attempt?.meta)).not.toContain('signature');
    });

    it('of PUBLISH_DRY_RUN applies to live adapters, not to the mock adapters', async () => {
      const live = createPublishJobTestbed();
      await expect(publish({ ...live, dryRunLive: true })).resolves.toMatchObject({ dryRun: true });
      expect(live.adapter.calls.publish).toBe(0);

      const mock = createPublishJobTestbed({ method: 'MOCK' });
      await expect(publish({ ...mock, dryRunLive: true })).resolves.toMatchObject({ dryRun: false });
      expect(mock.adapter.calls.publish).toBe(1);
    });
  });

  describe('the content', () => {
    it('goes out with the rendition of the platform, a signed URL and the alt text of its use', async () => {
      const bed = createPublishJobTestbed({ platform: 'INSTAGRAM' });
      bed.unitOfWork.state.media.set('variant-1', [
        {
          assetId: 'asset-1',
          crop: { x: 0, y: 120, width: 1080, height: 1350 },
          letterbox: false,
          altText: 'Kiel',
        },
      ]);
      bed.unitOfWork.setRendition('asset-1', 'instagram_feed', 'x0y120w1080h1350', {
        storageKey: 'ws/ws-1/assets/asset-1/instagram_feed-x0y120w1080h1350.jpg',
        mimeType: 'image/jpeg',
        width: 1080,
        height: 1350,
        sizeBytes: 400_000,
      });

      await publish(bed);

      expect(bed.adapter.requests[0]?.media).toEqual([
        {
          url: 'https://storage.example/ws/ws-1/assets/asset-1/instagram_feed-x0y120w1080h1350.jpg?signature=s',
          mimeType: 'image/jpeg',
          width: 1080,
          height: 1350,
          sizeBytes: 400_000,
          altText: 'Kiel',
        },
      ]);
    });

    it('waits for a rendition that is still being made', async () => {
      const bed = createPublishJobTestbed();
      bed.unitOfWork.state.media.set('variant-1', [
        { assetId: 'asset-1', crop: null, letterbox: true, altText: null },
      ]);

      await expect(publish(bed)).resolves.toMatchObject({ kind: 'retry', code: 'MEDIA_PROCESSING' });
      expect(bed.adapter.calls.publish).toBe(0);
    });

    it('fails when it breaks the rules of the platform, or there is nothing to post', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.issues = [{ code: 'TEXT_TOO_LONG', limit: 3000, actual: 3200 }];
      await expect(publish(bed)).resolves.toEqual({ kind: 'failed', code: 'VARIANT_NOT_PUBLISHABLE' });
      expect(bed.unitOfWork.variant().lastError).toBe('TEXT_TOO_LONG');

      const empty = createPublishJobTestbed({ variant: { text: '', hashtags: [] } });
      await expect(publish(empty)).resolves.toEqual({ kind: 'failed', code: 'VARIANT_NOT_PUBLISHABLE' });
      expect(empty.unitOfWork.variant().lastError).toBe('CONTENT_REQUIRED');
      expect(empty.adapter.calls.publish).toBe(0);
    });
  });

  describe('the account', () => {
    it('must still be connected, with a usable connection and an adapter', async () => {
      const gone = createPublishJobTestbed();
      const account = gone.unitOfWork.state.accounts.get('account-1');
      if (account) {
        account.disconnectedAt = new Date(NOW - 1000);
      }
      await expect(publish(gone)).resolves.toEqual({ kind: 'failed', code: 'SOCIAL_ACCOUNT_DISCONNECTED' });

      const reauth = createPublishJobTestbed();
      reauth.unitOfWork.connection().status = 'NEEDS_REAUTH';
      await expect(publish(reauth)).resolves.toEqual({ kind: 'failed', code: 'REAUTH_REQUIRED' });

      const unavailable = createPublishJobTestbed();
      unavailable.adapters.resolve = () => Promise.resolve(null);
      await expect(publish(unavailable)).resolves.toEqual({ kind: 'failed', code: 'ADAPTER_UNAVAILABLE' });
    });
  });

  describe('a stopped run', () => {
    it('writes nothing more and leaves its attempt UNKNOWN when it stops while sending', async () => {
      const bed = createPublishJobTestbed();
      const stop = new AbortController();
      bed.adapter.duringPublish = () => {
        stop.abort(new Error('killed'));
        return Promise.reject(new Error('aborted'));
      };

      await expect(publish(bed, jobOf({ signal: stop.signal }))).rejects.toThrow('aborted');

      expect(bed.unitOfWork.variant()).toMatchObject({ status: 'PUBLISHING', leaseOwner: 'worker-a:1' });
      expect(bed.unitOfWork.attempts()[0]).toMatchObject({ outcome: 'UNKNOWN', finishedAt: null });
      expect(bed.unitOfWork.statuses()).toEqual(['PUBLISHING']);
    });

    it('stops sending when another run took the variant over', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.duringReconcile = () => {
        // Another run claims the variant meanwhile.
        bed.unitOfWork.variant().version += 1;
        bed.unitOfWork.variant().leaseOwner = 'worker-b:2';
        return Promise.resolve();
      };
      leaveAttempt(bed, 'STARTED', 2);

      await expect(publish(bed)).resolves.toEqual({ kind: 'skipped', reason: 'LEASE_LOST' });
      expect(bed.adapter.calls.publish).toBe(0);
      expect(bed.unitOfWork.attempts()[1]).toMatchObject({ outcome: 'FAILED', errorCode: 'LEASE_LOST' });
      expect(bed.unitOfWork.variant().leaseOwner).toBe('worker-b:2');
    });

    it('extends its lease when the adapter asks before a long step', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.duringPublish = async (ctx) => {
        bed.clock.advance(4 * 60 * 1000);
        await ctx.keepAlive();
        expect(bed.unitOfWork.variant().leaseUntil).toEqual(new Date(NOW + 9 * 60 * 1000));
      };

      await expect(publish(bed)).resolves.toMatchObject({ kind: 'published' });
    });
  });

  describe('the notifications of guide step 4.9', () => {
    it('tells of a post that failed for good, and of none that only waits', async () => {
      const refused = createPublishJobTestbed();
      refused.adapter.publishAnswers = [new PlatformError('VALIDATION_REJECTED', 'refused')];
      await publish(refused);
      expect(refused.unitOfWork.notifications()).toEqual([
        { type: 'publish-failed', variantId: 'variant-1', failureCode: 'VALIDATION_REJECTED' },
      ]);

      const limited = createPublishJobTestbed();
      limited.adapter.publishAnswers = [new PlatformError('RATE_LIMITED', 'slow down')];
      await publish(limited);
      expect(limited.unitOfWork.notifications()).toEqual([]);
    });

    it('tells of a post that needs a decision', async () => {
      const bed = createPublishJobTestbed();
      bed.adapter.publishAnswers = [new PlatformError('OUTCOME_UNKNOWN', 'timeout after sending')];

      await publish(bed);

      expect(bed.unitOfWork.notifications()).toEqual([
        { type: 'needs-attention', variantId: 'variant-1', failureCode: 'OUTCOME_UNKNOWN' },
      ]);
    });

    it('tells of a missed window', async () => {
      const bed = createPublishJobTestbed({ variant: { scheduledAt: new Date(NOW - 7 * 60 * 60 * 1000) } });

      await publish(bed, jobOf({ trigger: 'sweep' }));

      expect(bed.unitOfWork.notifications()).toEqual([
        { type: 'publish-failed', variantId: 'variant-1', failureCode: 'MISSED_WINDOW' },
      ]);
    });
  });

  it('books the paid calls of a run once per operation, at their price', async () => {
    const bed = createPublishJobTestbed({ platform: 'X' });
    bed.adapter.duringPublish = async (ctx) => {
      await ctx.costs.record({ operation: 'x.post_create' });
      await ctx.costs.record({ operation: 'x.media_upload', units: 2 });
      await ctx.costs.record({ operation: 'x.media_upload' });
    };

    await publish(bed);

    expect(bed.unitOfWork.state.costs).toEqual([
      {
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        socialAccountId: 'account-1',
        platform: 'X',
        operation: 'x.post_create',
        units: 1,
        costMicros: 15_000,
        sourceType: 'publish_attempt',
        sourceId: 'attempt-1',
      },
      expect.objectContaining({ operation: 'x.media_upload', units: 3, costMicros: 0 }),
    ]);
    expect(bed.warnings).toEqual(['publish.price_unknown']);
    expect(bed.unitOfWork.variant().metricsNextAt).toEqual(new Date(NOW + 24 * 60 * 60 * 1000));
  });
});
