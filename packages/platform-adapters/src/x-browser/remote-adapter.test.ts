import { isPlatformError, type AdapterContext, type Clock } from '@smp/core';
import type { XbCommand, XbOperation, XbOutcome } from '@smp/x-browser';
import { describe, expect, it } from 'vitest';

import { CommandNotAnsweredError, type SendOptions, type XbCommandBus } from './command-bus';
import { X_BROWSER_MAP_VERSION } from './metrics-map';
import { XB_START_WINDOW_MS, XBrowserRemoteAdapter } from './remote-adapter';

// Guide step 6.3: every call of the browser adapter becomes one command with the sealed session,
// the outcome comes back as the return value of the job, and the failures of the browser worker
// land in the error taxonomy of the adapters.

const NOW = new Date('2026-10-17T08:00:00Z');
const clock: Clock = { now: () => NOW };
const SESSION = Uint8Array.from([1, 2, 3, 4]);

interface Sent {
  operation: XbOperation;
  command: Record<string, unknown>;
  options: SendOptions;
}

class FakeBus implements XbCommandBus {
  readonly sent: Sent[] = [];
  constructor(
    private readonly answers: (operation: XbOperation, command: Record<string, unknown>) => unknown,
  ) {}

  async send<O extends XbOperation>(
    operation: O,
    command: XbCommand<O>,
    options: SendOptions,
  ): Promise<XbOutcome<O>> {
    this.sent.push({ operation, command: command, options });
    await options.heartbeat();
    const answer = this.answers(operation, command);
    if (answer instanceof Error) {
      throw answer;
    }
    return answer as XbOutcome<O>;
  }
}

const context = (overrides: Partial<AdapterContext> = {}): AdapterContext & { beats: number } => {
  const ctx = {
    beats: 0,
    account: {
      id: '0192d000-0000-7000-8000-000000000001',
      workspaceId: '0192d000-0000-7000-8000-000000000002',
      connectionId: '0192d000-0000-7000-8000-000000000003',
      platform: 'X' as const,
      type: 'PROFILE' as const,
      externalId: '1234567890',
      name: 'SMP Demo',
      handle: 'smp_demo',
      settings: { locale: 'en' },
    },
    credentials: {
      accessToken: () => Promise.reject(new Error('no token for the browser')),
      refreshToken: () => Promise.resolve(null),
    },
    browser: { organizationId: '0192d000-0000-7000-8000-000000000004', sessionSealed: SESSION },
    costs: { record: () => Promise.resolve() },
    logger: { info: () => undefined, warn: () => undefined },
    signal: new AbortController().signal,
    dryRun: false,
    keepAlive: () => {
      ctx.beats += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
  return ctx;
};

const ids = () => {
  let next = 0;
  return () => `0192d000-0000-7000-8000-${String((next += 1)).padStart(12, '0')}`;
};

const adapterWith = (bus: XbCommandBus) => new XBrowserRemoteAdapter({ bus, clock, newId: ids() });

const request = (media: { mimeType: string }[] = []) => ({
  variantId: 'variant-1',
  text: 'Hello X',
  firstComment: null,
  linkUrl: null,
  contentHash: 'hash',
  media: media.map((item, index) => ({
    url: `https://media.example.com/${String(index)}.jpg?X-Amz-Signature=abc`,
    mimeType: item.mimeType,
    width: 1200,
    height: 675,
    sizeBytes: 1000,
    altText: index === 0 ? 'A rocket' : null,
  })),
});

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (isPlatformError(error) ? error.code : `unexpected ${String(error)}`),
  );

describe('XBrowserRemoteAdapter', () => {
  it('sends a post with the sealed session, the account and the signed media, and keeps the lease alive', async () => {
    const bus = new FakeBus(() => ({
      ok: true,
      data: {
        externalPostId: '1846000000000000001',
        externalUrl: 'https://x.com/smp_demo/status/1846000000000000001',
        publishedAt: '2026-10-17T08:00:05.000Z',
      },
    }));
    const ctx = context();
    await expect(adapterWith(bus).publish(request([{ mimeType: 'image/jpeg' }]), ctx)).resolves.toEqual({
      externalPostId: '1846000000000000001',
      externalUrl: 'https://x.com/smp_demo/status/1846000000000000001',
      publishedAt: new Date('2026-10-17T08:00:05.000Z'),
    });
    expect(bus.sent).toHaveLength(1);
    const [sent] = bus.sent;
    expect(sent?.operation).toBe('publish');
    expect(sent?.command).toEqual({
      commandId: '0192d000-0000-7000-8000-000000000001',
      deadline: new Date(NOW.getTime() + XB_START_WINDOW_MS).toISOString(),
      text: 'Hello X',
      media: [
        {
          url: 'https://media.example.com/0.jpg?X-Amz-Signature=abc',
          mimeType: 'image/jpeg',
          altText: 'A rocket',
        },
      ],
      target: {
        organizationId: '0192d000-0000-7000-8000-000000000004',
        workspaceId: '0192d000-0000-7000-8000-000000000002',
        connectionId: '0192d000-0000-7000-8000-000000000003',
        accountId: '0192d000-0000-7000-8000-000000000001',
        externalUserId: '1234567890',
        handle: 'smp_demo',
        locale: 'en',
        session: Buffer.from(SESSION).toString('base64'),
      },
    });
    expect(sent?.options.waitMs).toBe(XB_START_WINDOW_MS + 4 * 60_000);
    expect(ctx.beats).toBe(1);
  });

  it('sends nothing without a session or for media the browser worker does not take', async () => {
    const bus = new FakeBus(() => new Error('not expected'));
    const adapter = adapterWith(bus);
    await expect(codeOf(adapter.publish(request(), context({ browser: undefined })))).resolves.toBe(
      'AUTH_EXPIRED',
    );
    await expect(codeOf(adapter.publish(request([{ mimeType: 'video/mp4' }]), context()))).resolves.toBe(
      'VALIDATION_REJECTED',
    );
    expect(bus.sent).toEqual([]);
  });

  it('lands the failures of the browser worker in the taxonomy of the adapters', async () => {
    const failing = (code: string, retryAfterMs?: number) =>
      adapterWith(
        new FakeBus(() => ({
          ok: false,
          error: { code, message: `failed with ${code}`, ...(retryAfterMs ? { retryAfterMs } : {}) },
        })),
      ).publish(request(), context());

    await expect(codeOf(failing('CHALLENGE_REQUIRED'))).resolves.toBe('CHALLENGE_REQUIRED');
    await expect(codeOf(failing('SELECTOR_DRIFT'))).resolves.toBe('SELECTOR_DRIFT');
    await expect(codeOf(failing('DUPLICATE'))).resolves.toBe('DUPLICATE');
    // Not started at all: after the deadline or while the kill switch was on.
    await expect(failing('EXPIRED')).rejects.toMatchObject({ code: 'TRANSIENT', retryable: true });
    await expect(failing('UNAVAILABLE')).rejects.toMatchObject({ code: 'TRANSIENT', retryable: true });
    await expect(failing('RATE_LIMITED', 900_000)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 900_000,
    });
  });

  it('counts a command without an outcome as maybe sent for a post and as transient for a read', async () => {
    const silent = adapterWith(new FakeBus(() => new CommandNotAnsweredError('timeout')));
    await expect(codeOf(silent.publish(request(), context()))).resolves.toBe('OUTCOME_UNKNOWN');
    await expect(
      codeOf(silent.deletePost({ externalPostId: '1846000000000000001', externalUrl: null }, context())),
    ).resolves.toBe('OUTCOME_UNKNOWN');
    await expect(
      codeOf(silent.reconcile({ text: 'Hello X', since: NOW, contentHash: 'hash' }, context())),
    ).resolves.toBe('TRANSIENT');
  });

  it('reads the counters of up to ten posts per command and maps them', async () => {
    const bus = new FakeBus((_operation, command) => ({
      ok: true,
      data: {
        items: (command['externalPostIds'] as string[]).map((id, index) =>
          index === 0 && id.endsWith('01')
            ? { kind: 'deleted', externalPostId: id }
            : {
                kind: 'metrics',
                externalPostId: id,
                counts: { views: 4210, likes: 87, replies: 6, reposts: 11, quotes: 2, bookmarks: 9 },
                raw: { rest_id: id },
              },
        ),
      },
    }));
    const refs = Array.from({ length: 12 }, (_, index) => ({
      externalPostId: `18460000000000000${String(index + 1).padStart(2, '0')}`,
      externalUrl: null,
    }));
    const results = await adapterWith(bus).fetchPostMetrics(refs, context());

    expect(bus.sent.map((sent) => (sent.command['externalPostIds'] as string[]).length)).toEqual([10, 2]);
    expect(results).toHaveLength(12);
    expect(results[0]).toEqual({ kind: 'deleted', externalPostId: '1846000000000000001' });
    expect(results[1]).toEqual({
      kind: 'metrics',
      externalPostId: '1846000000000000002',
      metrics: {
        impressions: 4210,
        reach: null,
        views: null,
        likes: 87,
        comments: 6,
        shares: 13,
        clicks: null,
        saves: 9,
      },
      raw: { rest_id: '1846000000000000002' },
      mappingVersion: X_BROWSER_MAP_VERSION,
    });
  });

  it('reads the followers of the account and renews no credentials', async () => {
    const bus = new FakeBus(() => ({ ok: true, data: { followers: 1520, raw: { id: '1234567890' } } }));
    const adapter = adapterWith(bus);
    await expect(adapter.fetchAccountMetrics({ from: NOW, to: NOW }, context())).resolves.toEqual({
      followers: 1520,
      reach: null,
      profileViews: null,
      raw: { id: '1234567890' },
      mappingVersion: X_BROWSER_MAP_VERSION,
    });
    await expect(adapter.refreshCredentials()).resolves.toEqual({ status: 'not_needed' });
    expect(() =>
      adapter.connector.authorizationUrl({ state: 's', redirectUri: 'r', codeChallenge: null }),
    ).toThrow();
  });
});
