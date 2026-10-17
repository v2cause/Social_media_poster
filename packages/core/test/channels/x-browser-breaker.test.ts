import { describe, expect, it } from 'vitest';

import { XBrowserBreaker } from '../../src';
import {
  InMemoryXBrowser,
  MemoryDriftCounter,
  RecordingAlerts,
  RecordingKillSignal,
} from '../in-memory-x-browser';

// Guide step 6.5: three drifts of the selector map within an hour switch X without the API off
// for every workspace, at once for the browser workers too, and tell the platform admins once. A
// failed canary tells them and counts as a drift.

const drift = { flow: 'publish', selector: 'composer.textbox', selectorsVersion: 'x-v1' };

function setup() {
  let now = new Date('2026-10-17T08:00:00Z');
  const clock = { now: () => now };
  const unitOfWork = new InMemoryXBrowser();
  const drifts = new MemoryDriftCounter();
  const killSignal = new RecordingKillSignal();
  const alerts = new RecordingAlerts();
  const breaker = new XBrowserBreaker({
    drifts,
    store: unitOfWork.admin(clock.now),
    killSignal,
    alerts,
    clock,
  });
  return {
    breaker,
    unitOfWork,
    drifts,
    killSignal,
    alerts,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('the circuit breaker of the X browser', () => {
  it('opens at the third drift within an hour and tells the platform admins once', async () => {
    const t = setup();
    await expect(t.breaker.drift(drift)).resolves.toEqual({ status: 'counted', drifts: 1 });
    t.advance(20 * 60_000);
    await expect(t.breaker.drift(drift)).resolves.toEqual({ status: 'counted', drifts: 2 });
    expect(t.killSignal.signals).toEqual([]);
    t.advance(20 * 60_000);

    await expect(t.breaker.drift({ ...drift, selector: 'composer.post' })).resolves.toEqual({
      status: 'opened',
      drifts: 3,
    });
    expect(t.unitOfWork.state.global).toMatchObject({ enabled: false });
    expect(t.killSignal.signals).toEqual([true]);
    expect(t.alerts.breakers).toEqual([
      { ...drift, selector: 'composer.post', drifts: 3, at: new Date('2026-10-17T08:40:00Z') },
    ]);
    // The count starts afresh.
    expect(t.drifts.times).toEqual([]);
  });

  it('forgets drifts older than an hour', async () => {
    const t = setup();
    await t.breaker.drift(drift);
    await t.breaker.drift(drift);
    t.advance(61 * 60_000);

    await expect(t.breaker.drift(drift)).resolves.toEqual({ status: 'counted', drifts: 1 });
    expect(t.unitOfWork.state.global).toBeNull();
  });

  it('keeps quiet when the kill switch is on already, and sets it for the browser workers anyway', async () => {
    const t = setup();
    await t.unitOfWork.admin(() => new Date()).setGlobalFlag(false);
    for (let count = 0; count < 2; count += 1) {
      await t.breaker.drift(drift);
    }

    await expect(t.breaker.drift(drift)).resolves.toEqual({ status: 'open', drifts: 3 });
    expect(t.killSignal.signals).toEqual([true]);
    expect(t.alerts.breakers).toEqual([]);
  });

  it('tells the platform admins of a failed canary and counts it as a drift', async () => {
    const t = setup();
    await expect(t.breaker.canary({ ok: true, missing: [], selectorsVersion: 'x-v1' })).resolves.toBeNull();
    expect(t.alerts.canaries).toEqual([]);

    const missing = ['composer.textbox', 'nav.profile'];
    await expect(t.breaker.canary({ ok: false, missing, selectorsVersion: 'x-v1' })).resolves.toEqual({
      status: 'counted',
      drifts: 1,
    });
    expect(t.alerts.canaries).toEqual([
      { missing, selectorsVersion: 'x-v1', at: new Date('2026-10-17T08:00:00Z') },
    ]);
    await t.breaker.drift(drift);
    await expect(t.breaker.canary({ ok: false, missing: [], selectorsVersion: 'x-v1' })).resolves.toEqual({
      status: 'opened',
      drifts: 3,
    });
    expect(t.alerts.breakers).toEqual([
      expect.objectContaining({ flow: 'canary', selector: 'canary', drifts: 3 }),
    ]);
  });
});
