import type { Platform } from '@smp/platform-rules';

// The channels context (architecture 4 and 6.2): connections to the platforms and the accounts
// they publish to.

/** How a connection reaches its platform. */
export const CONNECTION_METHODS = ['API', 'BROWSER', 'MOCK'] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

export const CONNECTION_STATUSES = ['ACTIVE', 'EXPIRING', 'NEEDS_REAUTH', 'PAUSED', 'REVOKED'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** A profile of a person, a company or Facebook page, an Instagram professional account. */
export const SOCIAL_ACCOUNT_TYPES = ['PROFILE', 'PAGE', 'BUSINESS'] as const;
export type SocialAccountType = (typeof SOCIAL_ACCOUNT_TYPES)[number];

/** A connection as the use cases see it. Its tokens stay sealed; only adapters open them. */
export interface SocialConnection {
  id: string;
  workspaceId: string;
  platform: Platform;
  method: ConnectionMethod;
  status: ConnectionStatus;
  externalUserId: string;
  displayName: string;
  accessTokenSealed: Uint8Array | null;
  refreshTokenSealed: Uint8Array | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  /** The scopes the platform granted. */
  scopes: string[];
  version: number;
}

/** A target to publish to, reached through a connection. */
export interface SocialAccount {
  id: string;
  workspaceId: string;
  connectionId: string;
  platform: Platform;
  type: SocialAccountType;
  externalId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  /** The token of the account itself, for example of a Facebook page. */
  accessTokenSealed: Uint8Array | null;
  disconnectedAt: Date | null;
  version: number;
}
