import type { MemberRole } from '../../tenancy/domain/types';

// Rules of the OAuth flow (architecture 10, guide step 4.5).

/** Connecting and disconnecting accounts is for owners and admins. */
export const canManageChannels = (role: MemberRole): boolean => role === 'OWNER' || role === 'ADMIN';

/** The state of an authorization is valid for 10 minutes, and only once. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** A consent waits 15 minutes for the selection of the accounts. */
export const PENDING_CONNECTION_TTL_MS = 15 * 60 * 1000;

/** The scopes asked for and not granted, in the order they were asked for. */
export const missingScopesOf = (requested: readonly string[], granted: readonly string[]): string[] =>
  requested.filter((scope) => !granted.includes(scope));

/**
 * When the user has to grant access again: with a refresh token when that one runs out (null if
 * never), without one when the access token does.
 */
export const accessExpiryOf = (connection: {
  hasRefreshToken: boolean;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}): Date | null =>
  connection.hasRefreshToken ? connection.refreshTokenExpiresAt : connection.accessTokenExpiresAt;
