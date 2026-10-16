import { randomUUID } from 'node:crypto';

import {
  isPlatformError,
  type AdapterContext,
  type Clock,
  type PlatformError,
  type PublishRequest,
} from '@smp/core';
import { describe, expect, it } from 'vitest';

import { encodeMockCode, pkceChallengeOf } from './mock-code';
import { InMemoryMockPlatformStore } from './mock-platform-store';
import { MockPlatformAdapter } from './mock-platform-adapter';

// The fail modes of the mock platforms (architecture 16) and its OAuth side.

let now = new Date('2026-10-16T10:00:00Z');
const clock: Clock = { now: () => now };

const setup = (settings: Record<string, unknown> = {}) => {
  const store = new InMemoryMockPlatformStore();
  const adapter = new MockPlatformAdapter('X', {
    store,
    clock,
    authorizeUrl: 'http://localhost:3000/api/dev/mock-oauth/authorize',
  });
  const ctx: AdapterContext = {
    account: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      platform: 'X',
      type: 'PROFILE',
      externalId: 'u-x',
      name: 'Mira',
      handle: 'mira',
      settings,
    },
    credentials: { accessToken: () => Promise.resolve('a'), refreshToken: () => Promise.resolve('r') },
    costs: { record: () => Promise.resolve() },
    logger: { info: () => undefined, warn: () => undefined },
    signal: new AbortController().signal,
    dryRun: false,
  };
  const request: PublishRequest = {
    variantId: randomUUID(),
    text: 'Hallo Kiel',
    firstComment: null,
    linkUrl: null,
    media: [],
    contentHash: 'h1',
  };
  return { store, adapter, ctx, request };
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const error: unknown = await promise.then(
    () => null,
    (failed: unknown) => failed,
  );
  return isPlatformError(error) ? error.code : String(error);
};

describe('MockPlatformAdapter', () => {
  it('limits once per variant with the wait of the settings, then publishes', async () => {
    const { adapter, ctx, request, store } = setup({ failMode: 'rate_limit_once', retryAfterSeconds: 5 });

    const error = await adapter.publish(request, ctx).catch((failed: unknown) => failed as PlatformError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 5_000, retryable: true });
    await expect(adapter.publish(request, ctx)).resolves.toHaveProperty('externalPostId');
    expect(store.callCount('publish', ctx.account.id)).toBe(2);
    expect(store.callCount('created', ctx.account.id)).toBe(1);
  });

  it('loses the answer without a post for unknown_outcome, so the reconcile finds nothing', async () => {
    const { adapter, ctx, request } = setup({ failMode: 'unknown_outcome' });

    await expect(codeOf(adapter.publish(request, ctx))).resolves.toBe('OUTCOME_UNKNOWN');
    await expect(
      adapter.reconcile({ text: request.text, since: new Date(0), contentHash: 'h1' }, ctx),
    ).resolves.toBeNull();
  });

  it('publishes before a slow answer, so a stopped worker finds the post again', async () => {
    const { adapter, ctx, request, store } = setup({ failMode: 'slow' });
    const stop = new AbortController();

    const pending = adapter.publish(request, { ...ctx, signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    await expect(pending).rejects.toThrow();
    expect(store.callCount('created', ctx.account.id)).toBe(1);
    await expect(
      adapter.reconcile({ text: request.text, since: new Date(0), contentHash: 'h1' }, ctx),
    ).resolves.toMatchObject({
      externalPostId: expect.stringMatching(/^mock-x-[0-9a-f]{16}$/) as unknown,
    });
  });

  it('refuses refresh and publish for auth_expired and a post for permanent', async () => {
    const expired = setup({ failMode: 'auth_expired' });
    await expect(codeOf(expired.adapter.publish(expired.request, expired.ctx))).resolves.toBe('AUTH_EXPIRED');
    await expect(codeOf(expired.adapter.refreshCredentials(expired.ctx))).resolves.toBe('AUTH_EXPIRED');
    const permanent = setup({ failMode: 'permanent' });
    await expect(codeOf(permanent.adapter.publish(permanent.request, permanent.ctx))).resolves.toBe(
      'VALIDATION_REJECTED',
    );
  });

  it('never sends in a dry run and grows its metrics over time', async () => {
    const { adapter, ctx, request } = setup();
    await expect(adapter.publish(request, { ...ctx, dryRun: true })).rejects.toThrow(/dry run/);

    const published = await adapter.publish(request, ctx);
    now = new Date(now.getTime() + 2 * 3_600_000);
    const [early] = await adapter.fetchPostMetrics([published], ctx);
    now = new Date(now.getTime() + 48 * 3_600_000);
    const [later] = await adapter.fetchPostMetrics([published], ctx);
    expect(later?.metrics.impressions ?? 0).toBeGreaterThan(early?.metrics.impressions ?? 0);
    const [again] = await adapter.fetchPostMetrics([published], ctx);
    expect(again?.metrics).toEqual(later?.metrics);
  });

  it('exchanges a code of the fake page only with the matching PKCE verifier', async () => {
    const { adapter } = setup();
    const verifier = 'verifier-'.padEnd(50, 'x');
    const code = encodeMockCode({
      platform: 'X',
      user: 'mira',
      scopes: ['tweet.read', 'tweet.write', 'offline.access'],
      challenge: pkceChallengeOf(verifier),
      expiresAt: now.getTime() + 60_000,
    });
    const url = new URL(
      adapter.connector.authorizationUrl({
        state: 's1',
        redirectUri: 'http://localhost:3000/api/oauth/X/callback',
        codeChallenge: 'c',
      }),
    );

    expect(url.pathname).toBe('/api/dev/mock-oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(adapter.connector.usesPkce).toBe(true);
    await expect(
      codeOf(adapter.connector.exchangeCode({ code, redirectUri: '', codeVerifier: 'wrong' })),
    ).resolves.toBe('VALIDATION_REJECTED');
    const grant = await adapter.connector.exchangeCode({ code, redirectUri: '', codeVerifier: verifier });
    expect(grant).toMatchObject({
      externalUserId: 'mira',
      scopes: ['tweet.read', 'tweet.write', 'offline.access'],
    });
    expect(grant.refreshToken).not.toBeNull();
    await expect(adapter.connector.listConnectableAccounts(grant)).resolves.toHaveLength(1);
    await expect(
      codeOf(adapter.connector.exchangeCode({ code: 'not-a-code', redirectUri: '', codeVerifier: verifier })),
    ).resolves.toBe('VALIDATION_REJECTED');
  });

  it('hands out no refresh token on X without offline.access', async () => {
    const { adapter } = setup();
    const verifier = 'verifier-'.padEnd(50, 'y');
    const code = encodeMockCode({
      platform: 'X',
      user: 'mira',
      scopes: ['tweet.read', 'tweet.write'],
      challenge: pkceChallengeOf(verifier),
      expiresAt: now.getTime() + 60_000,
    });

    const grant = await adapter.connector.exchangeCode({ code, redirectUri: '', codeVerifier: verifier });
    expect(grant).toMatchObject({ refreshToken: null, refreshTokenExpiresAt: null });
  });
});
