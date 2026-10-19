import { createSystemPrismaClient, membershipsOfUser, type UserMembership } from '@smp/db';

// The system client of scripts/reset-two-factor.ts (guide step 8.7): the memberships of a user
// lie in every organization, beyond the row-level security of a single tenant.

export interface MembershipLookup {
  memberships: (userId: string) => Promise<UserMembership[]>;
  close: () => Promise<void>;
}

export function openMembershipLookup(databaseSystemUrl: string): MembershipLookup {
  const system = createSystemPrismaClient(databaseSystemUrl);
  return {
    memberships: (userId) => membershipsOfUser(system, userId),
    close: () => system.$disconnect(),
  };
}
