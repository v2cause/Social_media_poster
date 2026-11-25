import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CreateOrganization } from '@smp/core';
import { membershipsOfUser, type SystemPrismaClient } from '@smp/db';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { SYSTEM_DATABASE_CLIENT } from '../../infrastructure/clients.module';
import { AUTH, type Auth, type AuthSession } from '../identity/auth';
import { LocalSession } from '../identity/local-session';

// The single-user mode (ADR 0046): the person who runs the app on their own machine uses it without
// signing in. At the start the API makes sure one local owner exists, as a real user with a real
// organization and workspace, so row-level security, the permission matrix and the audit log work
// as always. Requests without a session then act as this owner (AuthGuard).

/** The session of the local owner never ends; no cookie and no token belong to it. */
const NEVER = new Date('9999-12-31T23:59:59.000Z');

@Injectable()
export class LocalOwnerBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(LocalOwnerBootstrap.name);

  constructor(
    @Inject(API_ENV)
    private readonly env: Pick<ApiEnv, 'LOCAL_MODE' | 'LOCAL_USER_EMAIL' | 'LOCAL_USER_NAME'>,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(SYSTEM_DATABASE_CLIENT) private readonly system: SystemPrismaClient,
    private readonly localSession: LocalSession,
    private readonly createOrganization: CreateOrganization,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.LOCAL_MODE) {
      return;
    }
    const context = await this.auth.$context;
    const email = this.env.LOCAL_USER_EMAIL.toLowerCase();
    const user =
      (await context.internalAdapter.findUserByEmail(email))?.user ??
      (await context.internalAdapter.createUser(
        { email, name: this.env.LOCAL_USER_NAME, emailVerified: true },
        // Provisioned by the operator of the machine, the way an admin creates an account.
        { method: 'admin' },
      ));

    if ((await membershipsOfUser(this.system, user.id)).length === 0) {
      await this.createOrganization.execute({
        user: { id: user.id, emailVerified: true },
        name: this.env.LOCAL_USER_NAME,
        workspace: {
          name: this.env.LOCAL_USER_NAME,
          // The machine's own zone; the settings page changes it.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          contentLanguage: 'de',
          industry: null,
          targetAudience: null,
          goals: null,
          contentPillars: [],
        },
      });
      this.logger.log('local_mode.workspace_created');
    }

    const now = new Date();
    this.localSession.set({
      user,
      session: {
        id: 'local-mode',
        token: 'local-mode',
        userId: user.id,
        expiresAt: NEVER,
        createdAt: now,
        updatedAt: now,
        ipAddress: null,
        userAgent: null,
      },
    } as AuthSession);
    this.logger.warn('local_mode.active: requests without a session act as the local owner');
  }
}
