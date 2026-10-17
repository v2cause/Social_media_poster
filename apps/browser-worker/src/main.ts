import { sealerFromEnv } from '@smp/crypto';
import { createLogger } from '@smp/observability';
import {
  egressPolicy,
  selectorsV1,
  XB_COMMANDS_QUEUE,
  XB_KEYS,
  XB_REPORT,
  XB_RESULTS_QUEUE,
  type XbReport,
} from '@smp/x-browser';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

import { AccountGuard } from './account-guard';
import { ACTION_TIMEOUT_MS, BrowserHost } from './browser-host';
import { launchChromium } from './chromium';
import { CommandRunner } from './command-runner';
import { loadBrowserWorkerEnv } from './env';
import { flowsOf } from './flows';
import { mediaFetcher } from './media';
import { processCommand } from './processor';

// The browser worker (guide step 6.2): one Chromium, the commands of xb-commands with one or two
// at a time, the reports to xb-results. It reaches Redis as the user browser-worker and leaves
// its network only through the egress proxy. It holds no database or storage credentials.
function bootstrap(): void {
  const env = loadBrowserWorkerEnv(process.env);
  const logger = createLogger({ service: 'browser-worker', environment: env.NODE_ENV, level: env.LOG_LEVEL });

  if (!env.FEATURE_X_BROWSER_GLOBAL) {
    logger.info('browser-worker.disabled');
    return;
  }

  const sealer = sealerFromEnv('sessions', env);
  const policy = egressPolicy([...selectorsV1.hosts, ...env.XB_EGRESS_HOSTS]);
  const host = new BrowserHost({
    launch: () =>
      launchChromium({ executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, proxy: env.XB_EGRESS_PROXY }),
    policy,
  });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const reports = new Queue(XB_RESULTS_QUEUE, { connection: { url: env.REDIS_URL } });
  const report = async (item: XbReport): Promise<void> => {
    // Sessions leave Redis once stored; a failed report stays a day for a look.
    await reports.add(XB_REPORT, item, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: { age: 86_400 },
    });
  };
  const now = (): Date => new Date();
  const runner = new CommandRunner({
    host,
    guard: new AccountGuard(redis),
    sealer,
    flows: flowsOf({ selectors: selectorsV1, timeoutMs: ACTION_TIMEOUT_MS, now }),
    media: mediaFetcher(policy),
    report,
    killed: async () => (await redis.exists(XB_KEYS.kill)) === 1,
    now,
    logger,
  });

  const worker = new Worker(
    XB_COMMANDS_QUEUE,
    (job, token) =>
      processCommand(
        job,
        token,
        {
          run: (operation, command) => runner.run(operation, command),
          // The interactive login follows in guide step 6.4.
          login: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'The login is not available yet.' },
            }),
        },
        now,
      ),
    {
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      concurrency: env.XB_CONCURRENCY,
      // A command that stalls may have posted already: it fails instead of running again.
      maxStalledCount: 0,
    },
  );

  worker.on('failed', (job, error) => {
    logger.warn({ jobId: job?.id, command: job?.name, errorName: error.name }, 'xb.command.error');
  });
  worker.on('error', (error: Error) => {
    logger.error({ errorName: error.name }, 'browser-worker.error');
  });

  const shutdown = (): void => {
    // Closing the worker waits for the commands in progress, then the browser and Redis go.
    void worker
      .close()
      .then(() => Promise.all([host.close(), reports.close()]))
      .then(() => redis.quit())
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  logger.info(
    { queue: XB_COMMANDS_QUEUE, concurrency: env.XB_CONCURRENCY, selectors: selectorsV1.version },
    'browser-worker.ready',
  );
}

try {
  bootstrap();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
