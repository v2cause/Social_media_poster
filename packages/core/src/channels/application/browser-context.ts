import type { SocialConnection } from '../domain/types';
import type { BrowserContext } from '../ports/platform-adapter';

/**
 * The part of an adapter context only the browser adapter of X gets (guide step 6.3): the
 * organization and the sealed session of its connection. Other methods get nothing of it.
 */
export const browserContextOf = (
  target: { connection: SocialConnection },
  organizationId: string,
): { browser?: BrowserContext } =>
  target.connection.method === 'BROWSER'
    ? { browser: { organizationId, sessionSealed: target.connection.sessionSealed } }
    : {};
