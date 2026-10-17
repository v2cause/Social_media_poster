import { createLogger } from '@smp/observability';
import { egressPolicy, X_WEB_HOSTS } from '@smp/x-browser';

import { loadEgressProxyEnv } from './env';
import { createEgressProxy } from './proxy';

// The only way out of the internal network of the browser worker (guide step 6.2).
function bootstrap(): void {
  const env = loadEgressProxyEnv(process.env);
  const logger = createLogger({ service: 'egress-proxy', environment: env.NODE_ENV, level: env.LOG_LEVEL });
  const hosts = [...X_WEB_HOSTS, ...env.XB_EGRESS_HOSTS];
  const server = createEgressProxy(egressPolicy(hosts), logger);

  server.listen(env.EGRESS_PORT, () => {
    logger.info({ port: env.EGRESS_PORT, hosts }, 'egress-proxy.ready');
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    // Open tunnels do not keep the container from stopping.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

try {
  bootstrap();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
