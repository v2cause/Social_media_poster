import { riskTextOf, X_BROWSER_RISK } from '@smp/contracts';
import { systemClock, XBrowserBreaker, XBrowserGate, type SocialPlatformAdapter } from '@smp/core';
import {
  createSystemPrismaClient,
  PrismaXBrowserAdminStore,
  PrismaXBrowserOperations,
  PrismaXBrowserUnitOfWork,
  type PrismaClient,
} from '@smp/db';
import {
  BullXbCommandBus,
  RedisSelectorDriftCounter,
  RedisXBrowserKillSignal,
  XBrowserRemoteAdapter,
  type BrowserGate,
} from '@smp/platform-adapters';
import { NOTIFICATIONS_QUEUE, NotificationProducer } from '@smp/queue';
import { XB_COMMANDS_QUEUE } from '@smp/x-browser';
import { Queue, QueueEvents } from 'bullmq';
import type Redis from 'ioredis';

import type { WorkerEnv } from '../worker-env';
import { EmailXBrowserAlerts } from './x-browser-alerts';

// The X browser of the roles "publisher" and "analytics" (guide step 6.3): the browser adapter of
// X, which sends its commands to xb-commands, and its gate, read in the tenant of the workspace
// as app_user (kill switch, organization, workspace, risk acknowledgement). Without
// FEATURE_X_BROWSER_GLOBAL there is neither; the registry then refuses the method BROWSER.

/** The gate is asked before every call; the kill switch reaches the browser worker at once anyway. */
export const GATE_CACHE_MS = 15_000;
const GATE_CACHE_SIZE = 10_000;

export interface XBrowserWiring {
  /** For the registry: the adapter of the method BROWSER and its gate. */
  browser?: { adapter: SocialPlatformAdapter; gate: BrowserGate };
  close(): Promise<void>;
}

/** Remembers the answer of the gate per workspace for a few seconds. */
export function cachedGate(gate: BrowserGate, now: () => number, ttlMs = GATE_CACHE_MS): BrowserGate {
  const answers = new Map<string, { allowed: boolean; until: number }>();
  return async (scope) => {
    const key = `${scope.organizationId}:${scope.workspaceId}`;
    const known = answers.get(key);
    if (known && known.until > now()) {
      return known.allowed;
    }
    const allowed = await gate(scope);
    if (answers.size >= GATE_CACHE_SIZE) {
      answers.clear();
    }
    answers.set(key, { allowed, until: now() + ttlMs });
    return allowed;
  };
}

export function xBrowserWiring(env: WorkerEnv, database: PrismaClient): XBrowserWiring {
  if (!env.FEATURE_X_BROWSER_GLOBAL) {
    return { close: () => Promise.resolve() };
  }
  // The producer fails fast instead of queueing commands while Redis is away.
  const queue = new Queue(XB_COMMANDS_QUEUE, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null, enableOfflineQueue: false },
  });
  const events = new QueueEvents(XB_COMMANDS_QUEUE, { connection: { url: env.REDIS_URL } });
  const access = new XBrowserGate({
    unitOfWork: new PrismaXBrowserUnitOfWork(database),
    offered: true,
    riskText: riskTextOf(X_BROWSER_RISK),
  });
  return {
    browser: {
      adapter: new XBrowserRemoteAdapter({ bus: new BullXbCommandBus(queue, events), clock: systemClock }),
      gate: cachedGate(
        (scope) => access.allows(scope),
        () => Date.now(),
      ),
    },
    close: async () => {
      await events.close();
      await queue.close();
    },
  };
}

export interface BreakerWiring {
  breaker: XBrowserBreaker;
  close(): Promise<void>;
}

/**
 * The circuit breaker of the role "publisher" (guide step 6.5), which reads the drifts and the
 * canary on xb-results. As app_system it switches the global flag off and finds the platform
 * admins, whom it alerts by email with a link to the admin page at APP_URL. Without
 * FEATURE_X_BROWSER_GLOBAL no browser worker runs and nothing reports.
 */
export function xBrowserBreakerOf(env: WorkerEnv, redis: Redis): BreakerWiring | null {
  if (!env.FEATURE_X_BROWSER_GLOBAL) {
    return null;
  }
  if (!env.DATABASE_SYSTEM_URL || !env.APP_URL) {
    throw new Error(
      'Invalid configuration:\n  DATABASE_SYSTEM_URL and APP_URL are required for the role "publisher" when FEATURE_X_BROWSER_GLOBAL is true',
    );
  }
  const system = createSystemPrismaClient(env.DATABASE_SYSTEM_URL);
  // The producer fails fast instead of queueing commands while Redis is away; the report retries.
  const notifications = new Queue(NOTIFICATIONS_QUEUE, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null, enableOfflineQueue: false },
  });
  const breaker = new XBrowserBreaker({
    drifts: new RedisSelectorDriftCounter(redis),
    store: new PrismaXBrowserAdminStore(system),
    killSignal: new RedisXBrowserKillSignal(redis),
    alerts: new EmailXBrowserAlerts({
      admins: new PrismaXBrowserOperations(system),
      notifications: new NotificationProducer(notifications),
      adminUrl: new URL('/admin', env.APP_URL).toString(),
    }),
    clock: systemClock,
  });
  return {
    breaker,
    close: async () => {
      await notifications.close();
      await system.$disconnect();
    },
  };
}
