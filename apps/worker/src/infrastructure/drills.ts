import { createPrismaClient, seedLoadFixture, type LoadFixture, type LoadFixtureOptions } from '@smp/db';
import { XB_REPORT, XB_RESULTS_QUEUE, xbReportSchema, type XbReport } from '@smp/x-browser';
import { Queue } from 'bullmq';

// What scripts/drill.ts writes (guide step 8.7): organizations of their own with posts that fall
// due, through the data of the load test, and reports on xb-results as a browser worker sends
// them, with the options of its reports.

export async function seedDrillFixture(
  databaseSystemUrl: string,
  options: LoadFixtureOptions,
  password: string,
): Promise<LoadFixture> {
  const prisma = createPrismaClient(databaseSystemUrl);
  try {
    return await seedLoadFixture(prisma, options, password);
  } finally {
    await prisma.$disconnect();
  }
}

export async function addXbReports(redisUrl: string, reports: readonly XbReport[]): Promise<void> {
  const queue = new Queue(XB_RESULTS_QUEUE, { connection: { url: redisUrl } });
  try {
    for (const report of reports) {
      await queue.add(XB_REPORT, xbReportSchema.parse(report), {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: { age: 86_400 },
      });
    }
  } finally {
    await queue.close();
  }
}
