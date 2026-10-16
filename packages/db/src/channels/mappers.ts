import type { SocialAccount, SocialConnection } from '@smp/core';

import type {
  SocialAccount as SocialAccountRow,
  SocialConnection as SocialConnectionRow,
} from '../generated/prisma/client';

/** Copies into a buffer of its own, as Prisma expects for Bytes. */
export const bytesOf = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

export const toSocialConnection = (row: SocialConnectionRow): SocialConnection => ({
  id: row.id,
  workspaceId: row.workspaceId,
  platform: row.platform,
  method: row.method,
  status: row.status,
  externalUserId: row.externalUserId,
  displayName: row.displayName,
  accessTokenSealed: row.accessTokenSealed,
  refreshTokenSealed: row.refreshTokenSealed,
  accessTokenExpiresAt: row.accessTokenExpiresAt,
  refreshTokenExpiresAt: row.refreshTokenExpiresAt,
  scopes: row.scopes,
  version: row.version,
});

export const toSocialAccount = (row: SocialAccountRow): SocialAccount => ({
  id: row.id,
  workspaceId: row.workspaceId,
  connectionId: row.connectionId,
  platform: row.platform,
  type: row.type,
  externalId: row.externalId,
  name: row.name,
  handle: row.handle,
  avatarUrl: row.avatarUrl,
  accessTokenSealed: row.accessTokenSealed,
  disconnectedAt: row.disconnectedAt,
  version: row.version,
});
