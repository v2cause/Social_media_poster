import type { Platform } from '@smp/platform-rules';

import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { ConnectionMethod, SocialAccount, SocialAccountType, SocialConnection } from '../domain/types';

// The repositories of the channels context (guide step 4.5). Every method names the workspace;
// row-level security limits the statements to it as well (architecture 6.3).

/** What a new grant sets on a connection. */
export interface ConnectionGrant {
  displayName: string;
  accessTokenSealed: Uint8Array;
  refreshTokenSealed: Uint8Array | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  connectedById: string;
  grantedAt: Date;
}

export interface NewSocialConnection extends ConnectionGrant {
  id: string;
  workspaceId: string;
  platform: Platform;
  method: ConnectionMethod;
  externalUserId: string;
}

export interface SocialConnectionRepository {
  find(workspaceId: string, connectionId: string): Promise<SocialConnection | null>;
  findByExternalUser(
    workspaceId: string,
    platform: Platform,
    method: ConnectionMethod,
    externalUserId: string,
  ): Promise<SocialConnection | null>;
  insert(connection: NewSocialConnection): Promise<void>;
  /** Replaces the grant, makes the connection ACTIVE again and raises its version. */
  replaceGrant(workspaceId: string, connectionId: string, grant: ConnectionGrant): Promise<void>;
  /** REVOKED, without tokens. */
  revoke(workspaceId: string, connectionId: string): Promise<void>;
}

/** An account as a confirmation stores it. */
export interface SocialAccountWrite {
  id: string;
  workspaceId: string;
  connectionId: string;
  platform: Platform;
  type: SocialAccountType;
  externalId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  accessTokenSealed: Uint8Array | null;
  connectedById: string;
}

export interface SocialAccountRepository {
  find(workspaceId: string, accountId: string): Promise<SocialAccount | null>;
  /** The accounts of the workspace with these external ids, disconnected ones included. */
  findByExternalIds(
    workspaceId: string,
    platform: Platform,
    externalIds: readonly string[],
  ): Promise<SocialAccount[]>;
  /**
   * Inserts the account, or connects the one with the same platform and external id again, now
   * through the given connection. Its id must then be the id of the existing account.
   */
  upsert(account: SocialAccountWrite): Promise<void>;
  /** Marks the account disconnected and drops its token; false when it was already. */
  disconnect(workspaceId: string, accountId: string, at: Date): Promise<boolean>;
  /** How many accounts of the connection are still connected. */
  connectedCount(workspaceId: string, connectionId: string): Promise<number>;
}

/** The repositories of one transaction. */
export interface ChannelStore {
  connections: SocialConnectionRepository;
  accounts: SocialAccountRepository;
  audit: AuditTrail;
}

export interface ChannelScope {
  userId: string;
  organizationId: string;
  workspaceId: string;
}

export interface ChannelUnitOfWork {
  run<T>(scope: ChannelScope, work: (store: ChannelStore) => Promise<T>): Promise<T>;
}
