import { parseArgs } from 'node:util';

import { toLocale } from '@smp/contracts';
import type { PrismaClient, UserMembership } from '@smp/db';
import type { NotificationProducer } from '@smp/queue';
import { z } from 'zod';

// For operators (guide step 8.7, ASVS 6.4.4): removes the second factor of a user who lost both
// the app and the backup codes. The identity is proven as at the sign-up, through the mailbox:
// the reset works only within a day after a password reset through the link to the address,
// which also ended every session. It deletes the factor with its backup codes, ends the sessions
// again and tells the address. The check before it names the organizations of the person, whose
// owners confirm the person (runbook docs/runbooks/zweiter-faktor-verloren.md).

/** How long after a password reset the second factor may be removed. */
export const RESET_PROOF_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

export interface TwoFactorResetRequest {
  email: string;
  /** The reference of the support case, for the log. */
  ticket: string;
  /** Only report, change nothing. */
  check: boolean;
}

export type TwoFactorCheck =
  | { status: 'not_found' }
  | {
      status: 'found';
      userId: string;
      twoFactorEnabled: boolean;
      /** A platform admin needs the confirmation of a second one (runbook). */
      platformAdmin: boolean;
      /** The password reset within RESET_PROOF_HOURS, or null without one. */
      resetAt: Date | null;
      memberships: UserMembership[];
    };

export type TwoFactorReset =
  | { status: 'not_found' }
  /** The password was not reset through the link within RESET_PROOF_HOURS. */
  | { status: 'no_recent_password_reset' }
  | {
      status: 'reset';
      userId: string;
      /** When the password was reset; it must come after the request of the person. */
      resetAt: Date;
      hadSecondFactor: boolean;
      sessions: number;
      memberships: UserMembership[];
    };

export interface TwoFactorResetDependencies {
  prisma: PrismaClient;
  /** The memberships of a user in every organization (a scan as app_system). */
  memberships: (userId: string) => Promise<UserMembership[]>;
  notifications: Pick<NotificationProducer, 'dispatchEmail'>;
  /** The origin of the web app, for the link to the security page. */
  appUrl: string;
}

async function userOf(prisma: PrismaClient, email: string) {
  // Better Auth stores addresses in lower case.
  return prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: {
      id: true,
      email: true,
      name: true,
      locale: true,
      twoFactorEnabled: true,
      isPlatformAdmin: true,
      accounts: { where: { providerId: 'credential' }, select: { createdAt: true, updatedAt: true } },
    },
  });
}

/** The time of a password reset within RESET_PROOF_HOURS; a sign-up does not count as one. */
function recentReset(accounts: readonly { createdAt: Date; updatedAt: Date }[], now: Date): Date | null {
  const since = now.getTime() - RESET_PROOF_HOURS * HOUR_MS;
  const reset = accounts.find(
    (account) => account.updatedAt.getTime() >= since && account.updatedAt > account.createdAt,
  );
  return reset?.updatedAt ?? null;
}

/** What a reset would find, without changing anything. */
export async function checkTwoFactorReset(
  { prisma, memberships }: Pick<TwoFactorResetDependencies, 'prisma' | 'memberships'>,
  email: string,
  now: Date,
): Promise<TwoFactorCheck> {
  const user = await userOf(prisma, email);
  if (!user) {
    return { status: 'not_found' };
  }
  return {
    status: 'found',
    userId: user.id,
    twoFactorEnabled: user.twoFactorEnabled,
    platformAdmin: user.isPlatformAdmin,
    resetAt: recentReset(user.accounts, now),
    memberships: await memberships(user.id),
  };
}

export async function resetTwoFactor(
  { prisma, memberships, notifications, appUrl }: TwoFactorResetDependencies,
  email: string,
  now: Date,
): Promise<TwoFactorReset> {
  const user = await userOf(prisma, email);
  if (!user) {
    return { status: 'not_found' };
  }
  const resetAt = recentReset(user.accounts, now);
  if (!resetAt) {
    return { status: 'no_recent_password_reset' };
  }
  const [factors, , sessions] = await prisma.$transaction([
    prisma.twoFactor.deleteMany({ where: { userId: user.id } }),
    prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false } }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ]);
  await notifications.dispatchEmail(user.email, {
    template: 'two-factor-reset',
    locale: toLocale(user.locale),
    name: user.name,
    url: `${appUrl.replace(/\/$/, '')}/account/security`,
  });
  return {
    status: 'reset',
    userId: user.id,
    resetAt,
    hadSecondFactor: user.twoFactorEnabled || factors.count > 0,
    sessions: sessions.count,
    memberships: await memberships(user.id),
  };
}

const requestSchema = z.object({
  email: z.email().max(320),
  ticket: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._#-]{0,39}$/),
  check: z.boolean(),
});

/** The request of the command line: --user <email> --ticket <reference> [--check]. */
export function twoFactorResetRequestOf(args: readonly string[]): TwoFactorResetRequest | null {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { user: { type: 'string' }, ticket: { type: 'string' }, check: { type: 'boolean' } },
      strict: true,
    });
    const parsed = requestSchema.safeParse({
      email: values.user,
      ticket: values.ticket,
      check: values.check ?? false,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
