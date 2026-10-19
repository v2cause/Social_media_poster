import { sealerFromEnv } from '@smp/crypto';
import { createLogger, runInJobContext } from '@smp/observability';
import {
  egressPolicy,
  login,
  selectorsV1,
  XB_COMMANDS_QUEUE,
  XB_KEYS,
  XB_REPORT,
  XB_RESULTS_QUEUE,
  type FlowContext,
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
import { codeInbox, LoginRunner } from './login-runner';
import { mediaFetcher } from './media';
import { processCommand } from './processor';

// The browser worker (guide steps 6.2 and 6.4): one Chromium, the commands of xb-commands with one
// or two at a time, the interactive logins of X, the reports to xb-results. It reaches Redis as
// the user browser-worker and leaves its network only through the egress proxy. It holds no
// database or storage credentials.
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
  const flowContext: FlowContext = { selectors: selectorsV1, timeoutMs: ACTION_TIMEOUT_MS, now };
  const killed = async (): Promise<boolean> => (await redis.exists(XB_KEYS.kill)) === 1;
  const runner = new CommandRunner({
    host,
    guard: new AccountGuard(redis),
    sealer,
    flows: flowsOf(flowContext),
    media: mediaFetcher(policy),
    report,
    killed,
    now,
    logger,
  });
  const logins = new LoginRunner({
    host,
    sealer,
    login: (page, credentials, hooks) => login(page, flowContext, credentials, hooks),
    nextCode: codeInbox(redis, now),
    report,
    killed,
    now,
    selectorsVersion: selectorsV1.version,
    logger,
  });

  const worker = new Worker(
    XB_COMMANDS_QUEUE,
    // Every line of a command carries its job, queue, organization and workspace (ASVS 16.2.1).
    (job, token) =>
      runInJobContext(job, () =>
        processCommand(
          job,
          token,
          {
            run: (operation, command) => runner.run(operation, command),
            login: (command) => logins.run(command),
          },
          now,
        ),
      ),
    {
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      concurrency: env.XB_CONCURRENCY,
      // A command that stalls may have posted already: it fails instead of running again.
      maxStalledCount: 0,
    },
  );

  worker.on('failed', (job, error) => {
    const failed = (): void => {
      logger.warn({ jobId: job?.id, command: job?.name, errorName: error.name }, 'xb.command.error');
    };
    if (job) {
      runInJobContext(job, failed);
    } else {
      failed();
    }
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
