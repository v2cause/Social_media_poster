import { Injectable } from '@nestjs/common';

import type { AuthSession } from './auth';

/**
 * The session of the local owner in the single-user mode (ADR 0046). LocalOwnerBootstrap sets it
 * when the API starts; it stays empty otherwise, so every guard behaves as before.
 */
@Injectable()
export class LocalSession {
  private session: AuthSession | null = null;

  set(session: AuthSession): void {
    this.session = session;
  }

  get(): AuthSession | null {
    return this.session;
  }
}
