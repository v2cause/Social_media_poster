import type { Platform, PlatformCapabilities, ValidationIssue } from '@smp/platform-rules';

import type { ConnectionMethod, SocialAccountType } from '../domain/types';

// The port of the platform adapters (architecture 4.1), implemented in @smp/platform-adapters:
// one adapter per platform and connection method. Adapters get their HTTP client and rate limiter
// when they are built; the context of a call carries the account, its credentials (decrypted on
// demand, in memory only), the cost recorder, the logger, the abort signal and the dry-run flag.

/** Tokens of an OAuth grant, in plaintext only while a use case holds them. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  /** The scopes the platform granted. */
  scopes: readonly string[];
}

/** What the code exchange returns: the tokens and the platform user who granted them. */
export interface OAuthGrant extends TokenSet {
  externalUserId: string;
  displayName: string;
}

/** A target the grant can publish to, offered for selection after the OAuth flow. */
export interface ConnectableAccount {
  externalId: string;
  type: SocialAccountType;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  /** A token of the account itself, for example of a Facebook page. */
  accessToken: string | null;
}

export interface AuthorizationRequest {
  state: string;
  redirectUri: string;
  /** S256 challenge of the PKCE verifier, when the connector uses PKCE. */
  codeChallenge: string | null;
}

export interface OAuthConnector {
  /** The scopes the connector asks for. */
  readonly scopes: readonly string[];
  readonly usesPkce: boolean;
  authorizationUrl(request: AuthorizationRequest): string;
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthGrant>;
  listConnectableAccounts(grant: OAuthGrant): Promise<ConnectableAccount[]>;
  revoke(tokens: TokenSet): Promise<void>;
}

/** The account a call is about, as the adapter needs it. */
export interface AdapterAccount {
  id: string;
  workspaceId: string;
  connectionId: string;
  platform: Platform;
  type: SocialAccountType;
  externalId: string;
  name: string;
  handle: string | null;
  /** SocialAccount.settings, for example the latency and fail mode of the mock adapter. */
  settings: Readonly<Record<string, unknown>>;
}

/** Opens the sealed tokens only when the adapter asks for them. */
export interface CredentialsAccessor {
  accessToken(): Promise<string>;
  refreshToken(): Promise<string | null>;
}

/** Records the costs of paid calls (X); a no-op elsewhere. */
export interface ApiCostRecorder {
  record(entry: { operation: string; units?: number }): Promise<void>;
}

export interface AdapterLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * What the browser adapter of X needs on top (method BROWSER): the organization for its reports
 * and the session, which stays sealed until the browser worker opens it.
 */
export interface BrowserContext {
  organizationId: string;
  sessionSealed: Uint8Array | null;
}

export interface AdapterContext {
  account: AdapterAccount;
  credentials: CredentialsAccessor;
  /** Only for the method BROWSER. */
  browser?: BrowserContext;
  costs: ApiCostRecorder;
  logger: AdapterLogger;
  signal: AbortSignal;
  /** Validate and prepare, but send nothing. */
  dryRun: boolean;
  /**
   * Extends the lease of the publish job before a long step, for example while Instagram
   * processes a container (up to 5 minutes). Throws when the run lost its lease; a no-op outside
   * of publishing.
   */
  keepAlive(): Promise<void>;
}

export interface PublishMedia {
  /** A signed URL of the rendition, valid for an hour. */
  url: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  altText: string | null;
}

export interface PublishRequest {
  variantId: string;
  /** The text as it goes out, hashtags included. */
  text: string;
  firstComment: string | null;
  linkUrl: string | null;
  media: readonly PublishMedia[];
  /** The hash the reconcile searches for. */
  contentHash: string;
}

export interface ExternalPostRef {
  externalPostId: string;
  externalUrl: string | null;
}

export interface PublishResult extends ExternalPostRef {
  publishedAt: Date;
  /** Platform details for the attempt log, for example container ids. */
  meta?: Readonly<Record<string, unknown>>;
}

/**
 * Cumulative counters, normalized across platforms (architecture 8); null where a platform has no
 * such metric, never 0.
 */
export interface NormalizedPostMetrics {
  impressions: number | null;
  reach: number | null;
  /** The views Meta reports in place of impressions. */
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
}

/** The metrics of a post, or the answer that the platform no longer knows it (404). */
export type PostMetricsResult =
  | {
      kind: 'metrics';
      externalPostId: string;
      metrics: NormalizedPostMetrics;
      /** The answer of the platform, kept with the snapshot. */
      raw: unknown;
      /** The MAP_VERSION of the mapping from raw to normalized, raised whenever it changes. */
      mappingVersion: number;
    }
  | { kind: 'deleted'; externalPostId: string };

export interface AccountMetricsResult {
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
  raw: unknown;
  mappingVersion: number;
}

export interface DateRange {
  from: Date;
  to: Date;
}

export type RefreshOutcome =
  | { status: 'refreshed'; tokens: TokenSet }
  | { status: 'not_needed' }
  /** The platform offers no refresh (LinkedIn without partner approval): reconnect before expiry. */
  | { status: 'not_supported' };

export interface SocialPlatformAdapter {
  readonly platform: Platform;
  readonly method: ConnectionMethod;
  readonly connector: OAuthConnector;
  capabilities(type: SocialAccountType): PlatformCapabilities;
  /** Throws a PlatformError (AUTH_EXPIRED) when the platform refuses the refresh. */
  refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome>;
  /** Pure, without I/O. */
  validatePost(request: PublishRequest, type: SocialAccountType): ValidationIssue[];
  publish(request: PublishRequest, ctx: AdapterContext): Promise<PublishResult>;
  /** Looks for a post that an earlier, unclear attempt may have published. */
  reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null>;
  deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void>;
  /**
   * Batched: one call for many posts of the account where the platform allows it. A post without
   * a result got no answer this time and is asked for again later.
   */
  fetchPostMetrics(refs: readonly ExternalPostRef[], ctx: AdapterContext): Promise<PostMetricsResult[]>;
  fetchAccountMetrics(range: DateRange, ctx: AdapterContext): Promise<AccountMetricsResult>;
}
