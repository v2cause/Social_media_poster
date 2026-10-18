import { NIGHTLY_ROLLUP_DAYS } from '../../analytics/application/roll-up-analytics';
import type { Clock } from '../../shared/ports/clock';
import type { RetentionStore } from '../ports/retention-store';

// The retention periods (guide step 8.3, ADR 0038), applied every night by tick.maintenance:
// the raw data of AI generations (the input without the rendered prompt, and the output) after
// 180 days, processed webhook events and connection data after 30 days, and the metrics of an
// organization beyond the analytics history of its plan. The counts and costs of the AI
// generations stay for billing. Accounts whose address was not verified within a day go too
// (guide step 8.4), so that nobody holds an address by signing up with it. What a run leaves
// because of its limits follows the next night.

export const AI_RAW_DATA_DAYS = 180;
export const PROCESSED_WEBHOOK_DAYS = 30;
/** IP addresses and user agents, as long as the logs keep them. */
export const CONNECTION_DATA_DAYS = 30;
/** The verification link is valid for an hour; a day later the address is free again. */
export const UNVERIFIED_ACCOUNT_HOURS = 24;
/**
 * Metrics stay at least as long as the nightly rollup fills days again, plus the day before its
 * first, whose snapshot the rollup takes the growth from.
 */
export const MIN_METRICS_DAYS = NIGHTLY_ROLLUP_DAYS + 1;

/** Rows per statement. */
const BATCH = 1_000;
/** Statements per kind of data and night, and per organization for the metrics. */
const MAX_BATCHES = 100;
const ORGANIZATIONS_PER_PAGE = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionReport {
  aiRawDataCleared: number;
  webhooksDeleted: number;
  connectionDataCleared: number;
  unverifiedUsersDeleted: number;
  metricsDeleted: number;
  /** Organizations whose plan could not be read; their metrics wait for the next night. */
  metricsFailed: number;
}

export interface RetentionDependencies {
  store: RetentionStore;
  /** The days of analytics the plan of an organization keeps. */
  analyticsHistoryDays: (organizationId: string) => Promise<number>;
  clock: Clock;
}

const daysBefore = (now: Date, days: number): Date => new Date(now.getTime() - days * DAY_MS);

/** Runs a step until it changes fewer rows than a batch, at most MAX_BATCHES times. */
async function drain(step: (limit: number) => Promise<number>): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const changed = await step(BATCH);
    total += changed;
    if (changed < BATCH) {
      break;
    }
  }
  return total;
}

export class ApplyRetention {
  constructor(private readonly deps: RetentionDependencies) {}

  async execute(): Promise<RetentionReport> {
    const { store } = this.deps;
    const now = this.deps.clock.now();
    const aiRawDataCleared = await drain((limit) =>
      store.clearAiRawData(daysBefore(now, AI_RAW_DATA_DAYS), limit),
    );
    const webhooksDeleted = await drain((limit) =>
      store.deleteProcessedWebhooks(daysBefore(now, PROCESSED_WEBHOOK_DAYS), limit),
    );
    const connectionDataCleared = await drain((limit) =>
      store.clearConnectionData(daysBefore(now, CONNECTION_DATA_DAYS), limit),
    );
    const unverifiedUsersDeleted = await drain((limit) =>
      store.deleteUnverifiedUsers(new Date(now.getTime() - UNVERIFIED_ACCOUNT_HOURS * HOUR_MS), limit),
    );
    let metricsDeleted = 0;
    let metricsFailed = 0;
    let after: string | null = null;
    for (;;) {
      const organizations = await store.organizations(after, ORGANIZATIONS_PER_PAGE);
      for (const organizationId of organizations) {
        let days: number;
        try {
          days = Math.max(await this.deps.analyticsHistoryDays(organizationId), MIN_METRICS_DAYS);
        } catch {
          metricsFailed += 1;
          continue;
        }
        metricsDeleted += await drain((limit) =>
          store.deleteMetrics(organizationId, daysBefore(now, days), limit),
        );
      }
      if (organizations.length < ORGANIZATIONS_PER_PAGE) {
        break;
      }
      after = organizations.at(-1) ?? null;
    }
    return {
      aiRawDataCleared,
      webhooksDeleted,
      connectionDataCleared,
      unverifiedUsersDeleted,
      metricsDeleted,
      metricsFailed,
    };
  }
}
