import type { PrismaClient } from '@smp/db';

// For operators (guide step 8.4, ASVS 7.4.5): ends the sessions of one user or of everybody, for
// example after a compromise. Sessions live in the database only, without a cookie cache, so the
// next request of an ended session gets 401 and the browser signs in anew.

export type RevokeTarget = { email: string } | { all: true };

export interface RevokeReport {
  /** Whether the address named a user; always true for all users. */
  found: boolean;
  sessions: number;
}

export async function revokeSessions(prisma: PrismaClient, target: RevokeTarget): Promise<RevokeReport> {
  if ('all' in target) {
    const { count } = await prisma.session.deleteMany({});
    return { found: true, sessions: count };
  }
  // Better Auth stores addresses in lower case.
  const user = await prisma.user.findUnique({
    where: { email: target.email.trim().toLowerCase() },
    select: { id: true },
  });
  if (!user) {
    return { found: false, sessions: 0 };
  }
  const { count } = await prisma.session.deleteMany({ where: { userId: user.id } });
  return { found: true, sessions: count };
}

/** The target of the command line: --user <email> or --all. */
export function revokeTargetOf(args: readonly string[]): RevokeTarget | null {
  if (args.length === 1 && args[0] === '--all') {
    return { all: true };
  }
  if (args.length === 2 && args[0] === '--user' && args[1]?.includes('@')) {
    return { email: args[1] };
  }
  return null;
}
