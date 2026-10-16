import { describe, expect, it } from 'vitest';

import {
  isNoticeDue,
  MonitorTokens,
  noticeStageOf,
  PlatformError,
  RefreshConnection,
  statusAfterRefresh,
  type RefreshOutcome,
} from '../../src';
import { fakeSealer } from '../in-memory-channels';
import { ScriptedAdapter } from '../in-memory-publish-job';
import { InMemoryTokenMaintenance, seedConnection } from '../in-memory-token-maintenance';

// Guide step 4.9: tick.tokens renews access that runs out within 14 days where it can, reminds at
// 14, 7 and 1 days once per stage, and asks for a new grant once the access ran out; the job
// token.refresh renews under the lock and decides between ACTIVE, EXPIRING and NEEDS_REAUTH.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-16T12:00:00Z');
const clock = { now: () => new Date(NOW) };

describe('the rules of the token monitor', () => {
  const at = (days: number) => new Date(NOW + days * DAY_MS);

  it('reminds at the nearest of 14, 7 and 1 days, once per stage', () => {
    expect(noticeStageOf(at(20), new Date(NOW))).toBeNull();
    expect(noticeStageOf(at(14), new Date(NOW))).toBe(14);
    expect(noticeStageOf(at(9), new Date(NOW))).toBe(14);
    expect(noticeStageOf(at(5), new Date(NOW))).toBe(7);
    expect(noticeStageOf(at(0.5), new Date(NOW))).toBe(1);
    expect(noticeStageOf(at(-1), new Date(NOW))).toBeNull();
    expect(isNoticeDue(14, null)).toBe(true);
    expect(isNoticeDue(14, 14)).toBe(false);
    expect(isNoticeDue(7, 14)).toBe(true);
    expect(isNoticeDue(14, 7)).toBe(false);
  });

  it('keeps a renewed connection active only when its access lasts beyond the window', () => {
    expect(statusAfterRefresh(at(60), new Date(NOW))).toBe('ACTIVE');
    expect(statusAfterRefresh(null, new Date(NOW))).toBe('ACTIVE');
    expect(statusAfterRefresh(at(10), new Date(NOW))).toBe('EXPIRING');
  });
});

describe('MonitorTokens', () => {
  const setup = () => {
    const maintenance = new InMemoryTokenMaintenance();
    const requested: string[] = [];
    const monitor = new MonitorTokens({
      scanner: { expiring: (until) => Promise.resolve(maintenance.expiring(until)) },
      unitOfWork: maintenance,
      refreshes: {
        request: (job) => {
          requested.push(job.connectionId);
          return Promise.resolve();
        },
      },
      clock,
    });
    return { maintenance, requested, monitor };
  };

  it('asks for the refresh of an active connection inside the window', async () => {
    const { maintenance, requested, monitor } = setup();
    seedConnection(maintenance, NOW, { expiresInDays: 10 });

    await expect(monitor.execute()).resolves.toMatchObject({ checked: 1, refreshRequested: 1 });
    expect(requested).toEqual(['connection-1']);
    expect(maintenance.state.outbox).toEqual([]);
  });

  it('reminds the managers of an expiring connection once per stage', async () => {
    const { maintenance, monitor } = setup();
    seedConnection(maintenance, NOW, { status: 'EXPIRING', expiresInDays: 6 });

    await expect(monitor.execute()).resolves.toMatchObject({ reminded: 1 });
    await expect(monitor.execute()).resolves.toMatchObject({ reminded: 0 });

    expect(maintenance.connection().expiryNoticeDays).toBe(7);
    expect(maintenance.state.outbox).toEqual([
      {
        workspaceId: 'ws-1',
        type: 'notification.requested',
        payload: {
          type: 'token-expiring',
          connectionId: 'connection-1',
          daysLeft: 7,
          expiresAt: new Date(NOW + 6 * DAY_MS).toISOString(),
        },
      },
    ]);
  });

  it('asks for a new grant once the access ran out and marks the scheduled variants', async () => {
    const { maintenance, monitor } = setup();
    seedConnection(maintenance, NOW, { status: 'EXPIRING', expiresInDays: -0.1 });
    maintenance.state.variants.set('variant-1', {
      accountId: 'account-1',
      status: 'SCHEDULED',
      failureCode: null,
    });
    maintenance.state.variants.set('variant-2', {
      accountId: 'account-1',
      status: 'PUBLISHED',
      failureCode: null,
    });

    await expect(monitor.execute()).resolves.toMatchObject({ expired: 1 });

    expect(maintenance.connection()).toMatchObject({ status: 'NEEDS_REAUTH', statusReason: 'EXPIRED' });
    expect(maintenance.state.variants.get('variant-1')?.failureCode).toBe('REAUTH_REQUIRED');
    expect(maintenance.state.variants.get('variant-2')?.failureCode).toBeNull();
    expect(maintenance.state.outbox[0]?.payload).toEqual({
      type: 'reauth-required',
      connectionId: 'connection-1',
      reason: 'EXPIRED',
      scheduledVariants: 1,
    });
    // An hour later nothing happens again.
    await expect(monitor.execute()).resolves.toMatchObject({ checked: 0 });
  });

  it('leaves alone what lasts longer, and access that never runs out', async () => {
    const { maintenance, requested, monitor } = setup();
    seedConnection(maintenance, NOW, { expiresInDays: 30 });
    seedConnection(maintenance, NOW, {
      id: 'connection-x',
      platform: 'X',
      refreshTokenSealed: new Uint8Array([1]),
      refreshTokenExpiresAt: null,
      expiresInDays: 0.05,
    });

    await expect(monitor.execute()).resolves.toMatchObject({ checked: 0 });
    expect(requested).toEqual([]);
  });
});

describe('RefreshConnection', () => {
  const setup = (answer: RefreshOutcome | Error) => {
    const maintenance = new InMemoryTokenMaintenance();
    const adapter = new ScriptedAdapter('LINKEDIN', 'API', clock);
    adapter.refreshAnswers = [answer];
    const locked: string[] = [];
    const refresh = new RefreshConnection({
      unitOfWork: maintenance,
      adapters: { resolve: () => Promise.resolve(adapter) },
      sealer: fakeSealer,
      locks: {
        withConnectionLock: (id, work) => {
          locked.push(id);
          return work();
        },
      },
      clock,
      logger: { info: () => undefined, warn: () => undefined },
    });
    const job = { organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'connection-1' };
    return { maintenance, adapter, locked, run: () => refresh.execute(job) };
  };
  const renewed = (days: number): RefreshOutcome => ({
    status: 'refreshed',
    tokens: {
      accessToken: 'access-2',
      refreshToken: null,
      accessTokenExpiresAt: new Date(NOW + days * DAY_MS),
      refreshTokenExpiresAt: null,
      scopes: [],
    },
  });

  it('renews the access under the lock and starts the reminders again', async () => {
    const { maintenance, locked, run } = setup(renewed(60));
    seedConnection(maintenance, NOW, { status: 'EXPIRING', expiresInDays: 6, expiryNoticeDays: 7 });

    await expect(run()).resolves.toBe('refreshed');

    expect(locked).toEqual(['connection-1']);
    expect(maintenance.connection()).toMatchObject({
      status: 'ACTIVE',
      expiryNoticeDays: null,
      accessTokenExpiresAt: new Date(NOW + 60 * DAY_MS),
      lastRefreshedAt: new Date(NOW),
    });
  });

  it('marks a connection EXPIRING that the platform cannot renew', async () => {
    const { maintenance, run } = setup({ status: 'not_supported' });
    seedConnection(maintenance, NOW, { expiresInDays: 10 });

    await expect(run()).resolves.toBe('expiring');
    expect(maintenance.connection().status).toBe('EXPIRING');
    await expect(run()).resolves.toBe('unchanged');
  });

  it('keeps a renewal that still runs out soon EXPIRING', async () => {
    const { maintenance, run } = setup(renewed(5));
    seedConnection(maintenance, NOW, { expiresInDays: 10 });

    await expect(run()).resolves.toBe('expiring');
    expect(maintenance.connection().status).toBe('EXPIRING');
  });

  it('asks for a new grant when the platform refuses the refresh', async () => {
    const { maintenance, run } = setup(new PlatformError('AUTH_EXPIRED', 'refresh refused'));
    seedConnection(maintenance, NOW, { expiresInDays: 10 });

    await expect(run()).resolves.toBe('reauth');
    expect(maintenance.connection()).toMatchObject({
      status: 'NEEDS_REAUTH',
      statusReason: 'REFRESH_FAILED',
    });
    expect(maintenance.state.outbox[0]?.payload).toMatchObject({
      type: 'reauth-required',
      reason: 'REFRESH_FAILED',
    });
  });

  it('skips a connection without a connected account or with a new grant pending', async () => {
    const empty = setup(renewed(60));
    seedConnection(empty.maintenance, NOW, {});
    empty.maintenance.state.accounts.clear();
    await expect(empty.run()).resolves.toBe('skipped');

    const pending = setup(renewed(60));
    seedConnection(pending.maintenance, NOW, { status: 'NEEDS_REAUTH' });
    await expect(pending.run()).resolves.toBe('skipped');
    expect(pending.adapter.calls.refresh).toBe(0);
  });
});
