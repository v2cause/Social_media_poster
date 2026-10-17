import type { Clock } from '../../shared/ports/clock';
import type {
  SelectorDrift,
  SelectorDriftCounter,
  XBrowserAdminStore,
  XBrowserAlerts,
  XBrowserKillSignal,
} from '../ports/x-browser';

// The circuit breaker of the X browser (guide step 6.5, architecture 4.3). Every drift of the
// selector map a browser worker reports counts; the third within an hour switches X without the
// API off for every workspace, through the global flag and at once through the kill switch of the
// browser workers, and tells the platform admins. A failed canary tells them as well and counts
// as a drift. Only the platform admins switch it on again, once the selector map fits X again.

export const BREAKER_DRIFTS = 3;
export const BREAKER_WINDOW_MS = 60 * 60_000;

export interface XBrowserBreakerDependencies {
  drifts: SelectorDriftCounter;
  store: Pick<XBrowserAdminStore, 'closeGlobalFlag'>;
  killSignal: XBrowserKillSignal;
  alerts: XBrowserAlerts;
  clock: Clock;
}

export type BreakerOutcome =
  | { status: 'counted'; drifts: number }
  | { status: 'opened'; drifts: number }
  /** The kill switch was on already, set by the admins or by another drift. */
  | { status: 'open'; drifts: number };

export interface CanaryReport {
  ok: boolean;
  /** The entries of the selector map the canary did not find. */
  missing: readonly string[];
  selectorsVersion: string;
}

export class XBrowserBreaker {
  constructor(private readonly deps: XBrowserBreakerDependencies) {}

  /** A drift a browser worker reported. */
  async drift(drift: SelectorDrift): Promise<BreakerOutcome> {
    const { deps } = this;
    const at = deps.clock.now();
    const drifts = await deps.drifts.record(at);
    if (drifts < BREAKER_DRIFTS) {
      return { status: 'counted', drifts };
    }
    // Two drifts at the same time both get here; the flag switches for one of them only.
    const opened = await deps.store.closeGlobalFlag();
    await deps.killSignal.set(true);
    await deps.drifts.reset();
    if (!opened) {
      return { status: 'open', drifts };
    }
    await deps.alerts.breakerOpened({ ...drift, drifts, at });
    return { status: 'opened', drifts };
  }

  /** The outcome of the daily canary; null when it found every selector. */
  async canary(report: CanaryReport): Promise<BreakerOutcome | null> {
    if (report.ok) {
      return null;
    }
    await this.deps.alerts.canaryFailed({
      missing: report.missing,
      selectorsVersion: report.selectorsVersion,
      at: this.deps.clock.now(),
    });
    return this.drift({
      flow: 'canary',
      selector: report.missing[0] ?? 'canary',
      selectorsVersion: report.selectorsVersion,
    });
  }
}
