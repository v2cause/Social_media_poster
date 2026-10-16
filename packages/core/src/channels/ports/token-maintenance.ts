import type { Platform } from '@smp/platform-rules';

import type { OutboxEventInput } from '../../shared/domain/outbox';
import type { ConnectionMethod, SocialConnection } from '../domain/types';
import type { AdapterAccount, SocialPlatformAdapter } from './platform-adapter';

// The repositories of the token refresh and the token monitor (guide steps 4.8 and 4.9). The
// refresh runs in the publish job and in the job token.refresh, the monitor in tick.tokens. Every
// method names the workspace; row-level security limits it to the scope as well.

/** The tokens of a refresh, sealed; a refresh without a new refresh token keeps the old one. */
export interface RefreshedTokens {
  accessTokenSealed: Uint8Array;
  accessTokenExpiresAt: Date | null;
  refreshTokenSealed: Uint8Array | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  refreshedAt: Date;
}

/** The connections as a token refresh reads and writes them. */
export interface TokenConnectionRepository {
  find(workspaceId: string, connectionId: string): Promise<SocialConnection | null>;
  /** Stores the tokens of a refresh if the version is current; false otherwise. */
  storeRefresh(
    workspaceId: string,
    connectionId: string,
    version: number,
    tokens: RefreshedTokens,
  ): Promise<boolean>;
}

/** What marking a connection NEEDS_REAUTH changed. */
export interface ReauthMark {
  /** False when the connection needed a new grant already, or is paused or revoked. */
  changed: boolean;
  /** The scheduled variants of its accounts, now marked with REAUTH_REQUIRED. */
  scheduledVariants: number;
}

export interface MaintainedConnectionRepository extends TokenConnectionRepository {
  /** The stage of the last expiry reminder, 14, 7 or 1; null when none went out. */
  expiryNoticeOf(workspaceId: string, connectionId: string): Promise<number | null>;
  /** ACTIVE or EXPIRING after a refresh; resetNotices starts the reminders again. */
  setExpiryStatus(
    workspaceId: string,
    connectionId: string,
    status: 'ACTIVE' | 'EXPIRING',
    resetNotices: boolean,
  ): Promise<void>;
  /** Notes the stage of a reminder if the last one is still the given one; false otherwise. */
  noteExpiryNotice(
    workspaceId: string,
    connectionId: string,
    stage: number,
    previous: number | null,
  ): Promise<boolean>;
  /**
   * NEEDS_REAUTH with the reason, from ACTIVE or EXPIRING; the scheduled variants of its accounts
   * get the failure code REAUTH_REQUIRED as a mark, keeping their status.
   */
  markNeedsReauth(workspaceId: string, connectionId: string, reason: string): Promise<ReauthMark>;
}

export interface ConnectedAccount {
  account: AdapterAccount;
  /** The token of the account itself, for example of a Facebook page. */
  accessTokenSealed: Uint8Array | null;
}

/** The repositories of one transaction of the token monitor or the token refresh. */
export interface TokenMaintenanceStore {
  connections: MaintainedConnectionRepository;
  accounts: {
    /** A connected account of the connection, for the context of its adapter. */
    anyConnected(workspaceId: string, connectionId: string): Promise<ConnectedAccount | null>;
  };
  outbox: { add(workspaceId: string, event: OutboxEventInput): Promise<void> };
}

export interface TokenMaintenanceScope {
  organizationId: string;
  workspaceId: string;
}

export interface TokenMaintenanceUnitOfWork {
  run<T>(scope: TokenMaintenanceScope, work: (store: TokenMaintenanceStore) => Promise<T>): Promise<T>;
}

/** A connection whose access runs out within the window, from the scan across workspaces. */
export interface ExpiringConnection {
  connectionId: string;
  workspaceId: string;
  organizationId: string;
  status: 'ACTIVE' | 'EXPIRING';
  method: ConnectionMethod;
  /** When the user has to grant access again (accessExpiryOf). */
  accessExpiresAt: Date;
  expiryNoticeDays: number | null;
}

export interface ExpiringConnectionScanner {
  /** Usable connections whose access runs out until then, the soonest first. */
  expiring(until: Date, limit: number): Promise<ExpiringConnection[]>;
}

/** Adds the job token.refresh of a connection; one waits per connection. */
export interface TokenRefreshRequests {
  request(job: { organizationId: string; workspaceId: string; connectionId: string }): Promise<void>;
}

/** The adapter of an account (architecture 4.1); null when none is available or its gate is closed. */
export interface AdapterResolver {
  resolve(account: {
    platform: Platform;
    method: ConnectionMethod;
    workspaceId: string;
  }): Promise<SocialPlatformAdapter | null>;
}

/** The Redis lock lock:conn:{id}, so only one refresh of a connection runs at a time. */
export interface ConnectionLock {
  withConnectionLock<T>(connectionId: string, work: () => Promise<T>): Promise<T>;
}
