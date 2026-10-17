import type { JobsOptions } from 'bullmq';

// Queue "scheduler" (architecture 7.4): the recurring ticks of the worker role "scheduler". Each
// tick is a BullMQ job scheduler named like the tick, so all replicas share one definition and a
// tick runs on one worker at a time. Cron patterns run in UTC. A tick that fails is not retried;
// the next one does the same work.

export const SCHEDULER_QUEUE = 'scheduler';

export const TICKS = [
  'tick.publish',
  'tick.sweep-queued',
  'tick.outbox-relay',
  'tick.analytics',
  'tick.tokens',
  'tick.account-metrics',
  'tick.maintenance',
  'tick.xb-canary',
  'tick.usage-report',
  'tick.read-only',
  'tick.gdpr',
] as const;
export type Tick = (typeof TICKS)[number];

export type TickSchedule = { every: number } | { pattern: string; tz: 'UTC' };

export const TICK_SCHEDULES: Readonly<Record<Tick, TickSchedule>> = {
  'tick.publish': { every: 15_000 },
  'tick.sweep-queued': { every: 60_000 },
  'tick.outbox-relay': { every: 1_000 },
  'tick.analytics': { every: 5 * 60_000 },
  'tick.tokens': { every: 60 * 60_000 },
  // Every hour: the accounts of the workspaces where it is past 03:00 and the numbers of the day
  // before are missing, spread over the hour (architecture 8).
  'tick.account-metrics': { pattern: '17 * * * *', tz: 'UTC' },
  // Nightly: re-wrap of the secrets, later the rollups and the clean-up.
  'tick.maintenance': { pattern: '41 3 * * *', tz: 'UTC' },
  // Daily, where an internal test account is configured: the canary of the X browser (guide step 6.5).
  'tick.xb-canary': { pattern: '23 5 * * *', tz: 'UTC' },
  // Daily after midnight UTC, where Stripe is set up: the usage of the day before (guide step 7.3).
  'tick.usage-report': { pattern: '7 0 * * *', tz: 'UTC' },
  // The owners of the organizations that became read-only meanwhile (guide step 7.4).
  'tick.read-only': { every: 15 * 60_000 },
  // Hourly: the role "gdpr" deletes the archives of expired exports (guide step 8.1).
  'tick.gdpr': { pattern: '29 * * * *', tz: 'UTC' },
};

const DAY_SECONDS = 24 * 60 * 60;

export const TICK_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: DAY_SECONDS },
};

export const isTick = (name: string): name is Tick => (TICKS as readonly string[]).includes(name);
