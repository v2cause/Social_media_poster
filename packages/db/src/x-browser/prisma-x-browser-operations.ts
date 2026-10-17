import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// What the circuit breaker and the canary of the X browser read across workspaces (guide step
// 6.5), as app_system: the platform admins to alert, and the internal test account the canary
// checks the selector map with.

export interface PlatformAdmin {
  email: string;
  name: string;
  locale: string;
}

/** The test account of the canary with the session of its browser connection. */
export interface XBrowserCanaryAccount {
  organizationId: string;
  workspaceId: string;
  connectionId: string;
  accountId: string;
  externalUserId: string;
  handle: string | null;
  /** SocialAccount.settings, with the language of X in the browser. */
  settings: unknown;
  sessionSealed: Uint8Array;
}

export class PrismaXBrowserOperations {
  constructor(private readonly system: SystemPrismaClient) {}

  /** The platform admins with a confirmed email address. */
  platformAdmins(): Promise<PlatformAdmin[]> {
    return runInSystemScope(() =>
      this.system.user.findMany({
        where: { isPlatformAdmin: true, emailVerified: true },
        select: { email: true, name: true, locale: true },
        orderBy: { email: 'asc' },
      }),
    );
  }

  /** The account, if it is a connected X account of a browser connection with a session. */
  async canaryAccount(accountId: string): Promise<XBrowserCanaryAccount | null> {
    const account = await runInSystemScope(() =>
      this.system.socialAccount.findFirst({
        where: {
          id: accountId,
          platform: 'X',
          disconnectedAt: null,
          connection: { method: 'BROWSER', status: 'ACTIVE', sessionSealed: { not: null } },
        },
        select: {
          id: true,
          workspaceId: true,
          connectionId: true,
          externalId: true,
          handle: true,
          settings: true,
          workspace: { select: { organizationId: true } },
          connection: { select: { sessionSealed: true } },
        },
      }),
    );
    const sessionSealed = account?.connection.sessionSealed;
    if (!account || !sessionSealed) {
      return null;
    }
    return {
      organizationId: account.workspace.organizationId,
      workspaceId: account.workspaceId,
      connectionId: account.connectionId,
      accountId: account.id,
      externalUserId: account.externalId,
      handle: account.handle,
      settings: account.settings,
      sessionSealed: new Uint8Array(sessionSealed),
    };
  }
}
