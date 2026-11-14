import { createSystemPrismaClient, PrismaUnlimitedAccess } from '@smp/db';

// The system client of scripts/grant-unlimited.ts (ADR 0047): plan and status of a subscription
// are not writable for app_user, and the organizations of a person lie in every tenant.

export interface UnlimitedAccessConnection {
  access: PrismaUnlimitedAccess;
  close: () => Promise<void>;
}

export function openUnlimitedAccess(databaseSystemUrl: string): UnlimitedAccessConnection {
  const system = createSystemPrismaClient(databaseSystemUrl);
  return { access: new PrismaUnlimitedAccess(system), close: () => system.$disconnect() };
}
