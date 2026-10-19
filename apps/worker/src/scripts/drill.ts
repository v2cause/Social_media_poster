import { observabilityEnvSchema, createLogger, loadSecretFiles } from '@smp/observability';
import { mockAccountSettingsSchema, platformEnvSchema, usesMockPlatform } from '@smp/platform-adapters';
import type { XbReport } from '@smp/x-browser';
import { z } from 'zod';

import { addXbReports, seedDrillFixture } from '../infrastructure/drills';
import { DRILL_USAGE, drillOf, type Drill } from './drill-args';

// `node dist/scripts/drill.js <scenario>` (locally after `pnpm build`: pnpm drill <scenario>)
// injects the fault a runbook of guide step 8.7 is played through with, on a local or staging
// stack, never in production (docs/runbooks/alarme.md):
// - platform-outage: organizations of their own whose posts fall due in two minutes on all four
//   mock platforms; the accounts of one platform answer with a 5xx status for some minutes.
// - token-wave: the same, but one platform refuses the tokens, so the connections need a new login.
// - xb-drift, xb-canary: reports of a selector drift or of a failed canary, as a browser worker
//   sends them; three drifts within an hour open the circuit breaker of the X browser.
// The organizations stay, like those of `pnpm load:fixture`; selector and version "drill" mark the
// reports in logs and emails.

const MINUTE_MS = 60_000;
/** The posts fall due this long after the start, so that the scheduler plans them as usual. */
const DUE_IN_MS = 2 * MINUTE_MS;

const envSchema = observabilityEnvSchema
  .pick({ NODE_ENV: true, LOG_LEVEL: true })
  .extend(platformEnvSchema.shape)
  .extend({
    DATABASE_SYSTEM_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    SEED_USER_PASSWORD: z.string().min(12),
  });
type DrillEnv = z.infer<typeof envSchema>;

/** The settings of the mock accounts that fail, until the end of the fault. */
function failureOf(drill: Extract<Drill, { platform: unknown }>, now: Date) {
  const failUntil = new Date(now.getTime() + drill.minutes * MINUTE_MS).toISOString();
  return mockAccountSettingsSchema.parse(
    drill.scenario === 'platform-outage'
      ? { failStatus: drill.status, failUntil }
      : { failMode: 'auth_expired', failUntil },
  );
}

async function run(drill: Drill, env: DrillEnv, now: Date): Promise<Record<string, unknown>> {
  if (drill.scenario === 'xb-drift' || drill.scenario === 'xb-canary') {
    const reports: XbReport[] =
      drill.scenario === 'xb-drift'
        ? Array.from({ length: drill.count }, () => ({
            kind: 'drift',
            flow: 'publish',
            selector: 'drill',
            selectorsVersion: 'drill',
          }))
        : [{ kind: 'canary', ok: false, missing: ['drill'], selectorsVersion: 'drill' }];
    await addXbReports(env.REDIS_URL, reports);
    return { reports: reports.length };
  }
  if (!usesMockPlatform(env, drill.platform)) {
    throw new Error(`The drill needs the mock adapter of ${drill.platform}.`);
  }
  const failure = failureOf(drill, now);
  const fixture = await seedDrillFixture(
    env.DATABASE_SYSTEM_URL,
    {
      run: `d${now.getTime().toString(36).slice(-6)}`,
      organizations: drill.organizations,
      duePostsPerWorkspace: drill.duePosts,
      dueAt: new Date(Math.ceil((now.getTime() + DUE_IN_MS) / MINUTE_MS) * MINUTE_MS),
      spreadSeconds: 30,
      latencyMs: 100,
      failure: { platform: drill.platform, settings: failure },
      now,
    },
    env.SEED_USER_PASSWORD,
  );
  return {
    run: fixture.run,
    dueAt: fixture.dueAt,
    dueVariants: fixture.dueVariants,
    platform: drill.platform,
    failUntil: failure.failUntil,
  };
}

async function main(): Promise<void> {
  loadSecretFiles(process.env);
  const env = envSchema.parse(process.env);
  const logger = createLogger({ service: 'worker', environment: env.NODE_ENV, level: env.LOG_LEVEL });
  if (env.NODE_ENV === 'production') {
    logger.error('drill.refused: never in production');
    process.exitCode = 2;
    return;
  }
  const drill = drillOf(process.argv.slice(2));
  if (!drill) {
    process.stderr.write(`${DRILL_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await run(drill, env, new Date());
  logger.info({ scenario: drill.scenario, ...result }, 'drill.injected');
}

void main();
