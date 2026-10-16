import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { CostCalculator } from '@smp/core';
import { createPrismaClient, PrismaPriceCatalog } from '@smp/db';
import { z } from 'zod';

import { createAiProvider } from '../src/create-ai-provider';
import { aiEfforts, aiEnvSchema, checkAiEnv } from '../src/env';
import { PromptTokenEstimator } from '../src/estimate';
import { findPreviousReport, renderMarkdown, reportFileName } from './report';
import { runEval } from './runner';
import { loadSuite } from './suite';

// `pnpm eval:ai` (guide step 2.10): runs the golden briefs against the provider of the
// environment, never without a budget. Prices come from the price book of the database, the
// report goes to eval/reports as JSON and Markdown, compared with the previous run.
//
//   EVAL_BUDGET_MICROS=2000000 pnpm eval:ai                 all cases, at most 2 USD
//   EVAL_BUDGET_MICROS=500000 pnpm eval:ai --only de-       only the German cases
//   EVAL_BUDGET_MICROS=2000000 pnpm eval:ai --dry-run       estimates only, no AI calls

const evalEnvSchema = aiEnvSchema
  .extend({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1),
    // .env.example leaves it empty, which counts as unset.
    EVAL_BUDGET_MICROS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce
        .number({ error: 'required: the eval never runs without a budget in micro-USD' })
        .int()
        .positive(),
    ),
  })
  .superRefine(checkAiEnv);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      suite: { type: 'string', default: 'eval/golden-briefs.json' },
      out: { type: 'string', default: 'eval/reports' },
    },
  });
  const parsed = evalEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Names and messages only: the values may be secrets.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid eval environment: ${problems.join('; ')}`);
  }
  const env = parsed.data;
  const suite = loadSuite(resolve(values.suite));
  const only = values.only;
  const selected =
    only === undefined ? suite : { ...suite, cases: suite.cases.filter((entry) => entry.id.includes(only)) };

  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const costs = new CostCalculator({
      prices: new PrismaPriceCatalog(prisma),
      clock: { now: () => new Date() },
    });
    const report = await runEval({
      provider: createAiProvider(env, { nodeEnv: env.NODE_ENV }),
      suite: selected,
      model: env.AI_MODEL,
      effort: aiEfforts(env).generate,
      budgetMicros: env.EVAL_BUDGET_MICROS,
      costs,
      estimator: new PromptTokenEstimator(),
      dryRun: values['dry-run'],
      now: () => new Date(),
      log: (line) => {
        process.stdout.write(`${line}\n`);
      },
    });

    const directory = resolve(values.out);
    mkdirSync(directory, { recursive: true });
    const previous = findPreviousReport(directory, report);
    const markdown = renderMarkdown(report, previous);
    writeFileSync(join(directory, reportFileName(report, 'json')), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(directory, reportFileName(report, 'md')), markdown);
    process.stdout.write(`\n${markdown}\nReport: ${join(directory, reportFileName(report, 'md'))}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
