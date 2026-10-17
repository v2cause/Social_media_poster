import {
  isPlatformError,
  type AdapterContext,
  type PlatformErrorCode,
  type PublishRequest,
  type SocialAccountType,
  type SocialPlatformAdapter,
} from '@smp/core';
import type { describe as vitestDescribe, expect as vitestExpect, it as vitestIt } from 'vitest';

// The contract every platform adapter keeps (guide step 4.4): its capabilities, validation without
// I/O, publish and reconcile, the mapping of 401, 403, 429 and 5xx to the error taxonomy, and
// normalized metrics. Real adapters run it against recorded answers (fixtures), the mock adapter
// against its settings. The test passes its describe, it and expect: this package is built as
// CommonJS, and Vitest can only be imported, not required.

export interface TestRunner {
  describe: typeof vitestDescribe;
  it: typeof vitestIt;
  expect: typeof vitestExpect;
}

export interface AdapterContractFixtures {
  /** The account types the adapter publishes for. */
  accountTypes: readonly SocialAccountType[];
  /**
   * A context of a healthy account. With failStatus the platform answers every call with that
   * HTTP status, with Retry-After when retryAfterSeconds is set.
   */
  context(options?: {
    failStatus?: number;
    retryAfterSeconds?: number;
  }): AdapterContext | Promise<AdapterContext>;
  /** A post the platform accepts. */
  validRequest(): PublishRequest;
  /** A post the platform refuses, for example with a text over the limit. */
  invalidRequest(): PublishRequest;
}

interface Failure {
  code: string;
  retryable: boolean;
  retryAfterMs: number | undefined;
}

const ERROR_MAPPING: readonly [number, PlatformErrorCode, boolean][] = [
  [401, 'AUTH_EXPIRED', false],
  [403, 'PERMISSION_DENIED', false],
  [429, 'RATE_LIMITED', true],
  [500, 'TRANSIENT', true],
  [503, 'TRANSIENT', true],
];

async function failureOf(promise: Promise<unknown>): Promise<Failure> {
  const error: unknown = await promise.then(
    () => null,
    (failed: unknown) => failed,
  );
  if (!isPlatformError(error)) {
    throw new Error(`expected a PlatformError, got ${String(error)}`);
  }
  return { code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
}

const isCount = (value: number | null): boolean => value === null || (Number.isInteger(value) && value >= 0);

export function describeAdapterContract(
  runner: TestRunner,
  name: string,
  makeAdapter: () => SocialPlatformAdapter,
  fixtures: AdapterContractFixtures,
): void {
  const { describe, expect, it } = runner;

  describe(`adapter contract: ${name}`, () => {
    it('describes its capabilities for every account type it serves', () => {
      const adapter = makeAdapter();
      for (const type of fixtures.accountTypes) {
        const capabilities = adapter.capabilities(type);
        expect(capabilities.platform, type).toBe(adapter.platform);
        expect(capabilities.text.maxLength, type).toBeGreaterThan(0);
      }
    });

    it('validates without I/O: a valid post passes, an invalid one names its issues', () => {
      const adapter = makeAdapter();
      const type = fixtures.accountTypes[0] ?? 'PROFILE';
      expect(adapter.validatePost(fixtures.validRequest(), type)).toEqual([]);
      expect(adapter.validatePost(fixtures.invalidRequest(), type).length).toBeGreaterThan(0);
    });

    it('publishes and finds the post again by reconcile', async () => {
      const adapter = makeAdapter();
      const ctx = await fixtures.context();
      const request = fixtures.validRequest();
      const since = new Date(Date.now() - 60_000);

      const result = await adapter.publish(request, ctx);
      expect(result.externalPostId.length).toBeGreaterThan(0);

      const found = await adapter.reconcile(
        { text: request.text, since, contentHash: request.contentHash },
        ctx,
      );
      expect(found?.externalPostId).toBe(result.externalPostId);
      await expect(
        adapter.reconcile({ text: 'something else', since, contentHash: 'other-hash' }, ctx),
      ).resolves.toBeNull();
    });

    for (const [status, code, retryable] of ERROR_MAPPING) {
      it(`maps HTTP ${String(status)} to ${code}`, async () => {
        const adapter = makeAdapter();
        const ctx = await fixtures.context({ failStatus: status });
        const failure = await failureOf(adapter.publish(fixtures.validRequest(), ctx));
        expect(failure.code).toBe(code);
        expect(failure.retryable).toBe(retryable);
      });
    }

    it('passes the wait of Retry-After on with a 429', async () => {
      const adapter = makeAdapter();
      const ctx = await fixtures.context({ failStatus: 429, retryAfterSeconds: 30 });
      const failure = await failureOf(adapter.publish(fixtures.validRequest(), ctx));
      expect(failure).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 30_000 });
    });

    it('normalizes post metrics and reports account metrics', async () => {
      const adapter = makeAdapter();
      const ctx = await fixtures.context();
      const published = await adapter.publish(fixtures.validRequest(), ctx);

      const [result] = await adapter.fetchPostMetrics([published], ctx);
      if (result?.kind !== 'metrics') {
        throw new Error('expected the metrics of the post');
      }
      expect(result.externalPostId).toBe(published.externalPostId);
      expect(result.mappingVersion).toBeGreaterThanOrEqual(1);
      const { metrics } = result;
      const values = [
        metrics.impressions,
        metrics.reach,
        metrics.views,
        metrics.likes,
        metrics.comments,
        metrics.shares,
        metrics.clicks,
        metrics.saves,
      ];
      for (const value of values) {
        expect(isCount(value)).toBe(true);
      }
      const account = await adapter.fetchAccountMetrics(
        { from: new Date(Date.now() - 86_400_000), to: new Date() },
        ctx,
      );
      expect(isCount(account.followers)).toBe(true);
      expect(account.mappingVersion).toBeGreaterThanOrEqual(1);
    });

    it('reports a post deleted on the platform as deleted instead of failing the batch', async () => {
      const adapter = makeAdapter();
      const ctx = await fixtures.context();
      const kept = await adapter.publish(fixtures.validRequest(), ctx);
      const removed = await adapter.publish({ ...fixtures.validRequest(), text: 'removed later' }, ctx);
      await adapter.deletePost(removed, ctx);

      const results = await adapter.fetchPostMetrics([kept, removed], ctx);
      expect(results.map((result) => [result.externalPostId, result.kind])).toEqual([
        [kept.externalPostId, 'metrics'],
        [removed.externalPostId, 'deleted'],
      ]);
    });
  });
}
