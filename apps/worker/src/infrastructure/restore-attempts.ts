import { createSystemPrismaClient, markOpenAttemptsAfterRestore, type RestoreAttemptMarks } from '@smp/db';

// The system client of scripts/mark-open-attempts.ts (guide step 8.6): the mark after a restore
// reads and writes the variants of every workspace.

export async function markOpenAttempts(databaseSystemUrl: string, since: Date): Promise<RestoreAttemptMarks> {
  const system = createSystemPrismaClient(databaseSystemUrl);
  try {
    return await markOpenAttemptsAfterRestore(system, since);
  } finally {
    await system.$disconnect();
  }
}
