import type { Platform } from '@smp/platform-rules';

import type { ConnectionMethod } from '../domain/types';
import type { ConnectableAccount, OAuthConnector } from './platform-adapter';

// The ports of the OAuth flow (guide step 4.5, architecture 10): the state of an authorization
// and the consent parked until the user picks the accounts both live in Redis; the connectors
// come from the adapter registry.

/** What the callback needs to know about the start of an authorization. */
export interface OAuthState {
  userId: string;
  organizationId: string;
  workspaceId: string;
  /** Where the browser goes back to after the callback. */
  workspaceSlug: string;
  platform: Platform;
  method: ConnectionMethod;
  redirectUri: string;
  /** The PKCE verifier. It never leaves the server. */
  codeVerifier: string | null;
  /** The account the user reconnects, if any. */
  reconnectAccountId: string | null;
}

export interface OAuthStateStore {
  save(state: string, data: OAuthState, ttlMs: number): Promise<void>;
  /** Reads and removes a state in one step; null when it is unknown, used or expired. */
  take(state: string): Promise<OAuthState | null>;
}

/** A target of a consent as the selection shows it, without its token. */
export type ConnectableAccountView = Omit<ConnectableAccount, 'accessToken'>;

/** A consent waiting for the selection of the accounts. */
export interface PendingConnection {
  id: string;
  userId: string;
  organizationId: string;
  workspaceId: string;
  platform: Platform;
  method: ConnectionMethod;
  externalUserId: string;
  displayName: string;
  requestedScopes: string[];
  grantedScopes: string[];
  accounts: ConnectableAccountView[];
  /** The tokens of the grant and of the accounts, sealed with pendingSecretAad. */
  sealedSecrets: Uint8Array;
  reconnectAccountId: string | null;
  expiresAt: Date;
}

export interface PendingConnectionStore {
  /** Keeps the consent until its expiresAt. */
  save(pending: PendingConnection): Promise<void>;
  find(id: string): Promise<PendingConnection | null>;
  delete(id: string): Promise<void>;
}

/** The random values of the flow. */
export interface OAuthRandom {
  /** 32 random bytes as base64url: the state and the id of a pending connection. */
  token(): string;
  /** A PKCE verifier and its S256 challenge (RFC 7636). */
  pkce(): { verifier: string; challenge: string };
}

/** The connectors of the platforms on offer. */
export interface ChannelConnectors {
  /** The method new connections of the platform use; null when it is not on offer. */
  methodFor(platform: Platform): ConnectionMethod | null;
  /** The connector of a platform and method; null when it is not available. */
  connector(platform: Platform, method: ConnectionMethod): OAuthConnector | null;
}
