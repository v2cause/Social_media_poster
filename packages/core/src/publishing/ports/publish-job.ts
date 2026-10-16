import type { Platform } from '@smp/platform-rules';

import type { AdapterAccount, SocialPlatformAdapter } from '../../channels/ports/platform-adapter';
import type { ConnectionMethod, SocialConnection } from '../../channels/domain/types';
import type { VariantStatus } from '../../content/domain/types';
import type { Crop } from '../../media/domain/types';
import type { MissedWindowBehavior } from '../../tenancy/domain/types';
import type { OutboxWriter } from './publishing-store';

// The repositories and services of the publish job (guide step 4.8, architecture 7 and 7.1). The
// job runs without a user, in the tenant of its variant; every method names the workspace and
// row-level security limits the statements to it as well (architecture 6.3).

/** Why a publish job runs, as the queue names it (architecture 7.4). */
export const PUBLISH_JOB_TRIGGERS = ['schedule', 'now', 'retry', 'recheck', 'sweep'] as const;
export type PublishJobTrigger = (typeof PUBLISH_JOB_TRIGGERS)[number];

/** A variant as the publish job sees it, with the settings of its workspace. */
export interface PublishJobVariant {
  id: string;
  workspaceId: string;
  postId: string;
  platform: Platform;
  status: VariantStatus;
  version: number;
  scheduleVersion: number;
  socialAccountId: string | null;
  text: string;
  hashtags: string[];
  firstComment: string | null;
  linkUrl: string | null;
  scheduledAt: Date | null;
  queuedAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  /** WorkspaceSettings.dryRun: validate and record, but send nothing. */
  dryRun: boolean;
  missedWindowBehavior: MissedWindowBehavior;
}

export interface Lease {
  owner: string;
  until: Date;
}

/** How a run of the lease holder ends for the variant. */
export type VariantRunResult =
  | {
      status: 'PUBLISHED';
      publishedAt: Date;
      externalPostId: string | null;
      externalUrl: string | null;
      contentHash: string;
      isDryRun: boolean;
      metricsNextAt: Date | null;
    }
  | {
      status: 'RETRYING' | 'FAILED' | 'NEEDS_ATTENTION';
      failureCode: string;
      /** Without tokens or response bodies. */
      lastError: string | null;
    };

export interface PublishJobVariantRepository {
  /** The variant, locked until the end of the transaction, so claims run one after the other. */
  lockForJob(workspaceId: string, variantId: string): Promise<PublishJobVariant | null>;
  /**
   * PUBLISHING with the lease, if the version is current. Returns the new version, or null when
   * the variant changed meanwhile.
   */
  claim(workspaceId: string, variantId: string, version: number, lease: Lease): Promise<number | null>;
  /**
   * Moves the end of the lease the same way, by compare-and-swap on the version, if the run still
   * holds it. Returns the new version, or null when the lease is lost.
   */
  extendLease(workspaceId: string, variantId: string, version: number, lease: Lease): Promise<number | null>;
  /**
   * Ends the run of the lease holder: the new status with its fields, the lease cleared. False
   * when another run took the variant over meanwhile.
   */
  finish(
    workspaceId: string,
    variantId: string,
    version: number,
    owner: string,
    result: VariantRunResult,
  ): Promise<boolean>;
  /** FAILED without a run, for a missed window; false when the version changed. */
  fail(workspaceId: string, variantId: string, version: number, failureCode: string): Promise<boolean>;
}

export const PUBLISH_ATTEMPT_OUTCOMES = [
  'STARTED',
  'PUBLISHED',
  'RECONCILED',
  'DRY_RUN',
  'RETRY',
  'FAILED',
  'UNKNOWN',
] as const;
export type PublishAttemptOutcome = (typeof PUBLISH_ATTEMPT_OUTCOMES)[number];

/**
 * An attempt whose outcome is open: STARTED (the run stopped, maybe before it sent anything) or
 * UNKNOWN (the request went out, the answer is missing).
 */
export interface UnclearAttempt {
  scheduleVersion: number;
  outcome: 'STARTED' | 'UNKNOWN';
  startedAt: Date;
}

export interface NewPublishAttempt {
  id: string;
  workspaceId: string;
  variantId: string;
  scheduleVersion: number;
  trigger: PublishJobTrigger;
  leaseOwner: string;
  startedAt: Date;
}

export interface PublishAttemptResult {
  outcome: Exclude<PublishAttemptOutcome, 'STARTED'>;
  errorCode: string | null;
  /** Without tokens or response bodies. */
  errorMessage: string | null;
  externalPostId: string | null;
  /** Platform details, or the payload of a dry run; never signed URLs or tokens. */
  meta: Readonly<Record<string, unknown>>;
  finishedAt: Date;
}

export interface PublishAttemptRepository {
  /** The attempts of the variant whose outcome is open, oldest first. */
  unclear(workspaceId: string, variantId: string): Promise<UnclearAttempt[]>;
  /** Inserts a STARTED attempt with the next number of its schedule version; returns that number. */
  start(attempt: NewPublishAttempt): Promise<number>;
  /** UNKNOWN right before the request goes out, so a stopped run leaves the attempt unclear. */
  markSent(workspaceId: string, attemptId: string): Promise<void>;
  finish(workspaceId: string, attemptId: string, result: PublishAttemptResult): Promise<void>;
}

/** The account of a variant with its connection, as the job needs it to call the platform. */
export interface PublishJobTarget {
  account: AdapterAccount;
  disconnectedAt: Date | null;
  /** The token of the account itself, for example of a Facebook page. */
  accessTokenSealed: Uint8Array | null;
  connection: SocialConnection;
}

export interface PublishJobTargetRepository {
  find(workspaceId: string, accountId: string): Promise<PublishJobTarget | null>;
}

/** The tokens of a refresh, sealed; a refresh without a new refresh token keeps the old one. */
export interface RefreshedTokens {
  accessTokenSealed: Uint8Array;
  accessTokenExpiresAt: Date | null;
  refreshTokenSealed: Uint8Array | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  refreshedAt: Date;
}

export interface PublishJobConnectionRepository {
  find(workspaceId: string, connectionId: string): Promise<SocialConnection | null>;
  /** Stores the tokens of a refresh if the version is current; false otherwise. */
  storeRefresh(
    workspaceId: string,
    connectionId: string,
    version: number,
    tokens: RefreshedTokens,
  ): Promise<boolean>;
  /** NEEDS_REAUTH with the reason, for example REFRESH_FAILED. */
  markNeedsReauth(workspaceId: string, connectionId: string, reason: string): Promise<void>;
}

/** An attached image with crop, letterbox and the alt text of this use (or of the asset). */
export interface PublishMediaItem {
  assetId: string;
  crop: Crop | null;
  letterbox: boolean;
  altText: string | null;
}

/** The file of an image for a platform. */
export interface PublishRendition {
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface PublishJobMediaRepository {
  /** The media of a variant in their order. */
  itemsOf(workspaceId: string, variantId: string): Promise<PublishMediaItem[]>;
  rendition(
    workspaceId: string,
    assetId: string,
    profile: string,
    cropHash: string,
  ): Promise<PublishRendition | null>;
}

/** The cost of a paid platform call, booked once per source and operation. */
export interface ApiCostEntry {
  organizationId: string;
  workspaceId: string;
  socialAccountId: string;
  platform: Platform;
  operation: string;
  units: number;
  costMicros: number;
  sourceType: 'publish_attempt';
  sourceId: string;
}

export interface ApiCostRepository {
  /** Inserts the entries; an entry of a source and operation that exists already is skipped. */
  record(entries: readonly ApiCostEntry[]): Promise<void>;
}

/** The repositories of one transaction. */
export interface PublishJobStore {
  variants: PublishJobVariantRepository;
  attempts: PublishAttemptRepository;
  targets: PublishJobTargetRepository;
  connections: PublishJobConnectionRepository;
  media: PublishJobMediaRepository;
  costs: ApiCostRepository;
  outbox: OutboxWriter;
}

/** The tenant of a job; jobs act without a user. */
export interface PublishJobScope {
  organizationId: string;
  workspaceId: string;
}

export interface PublishJobUnitOfWork {
  run<T>(scope: PublishJobScope, work: (store: PublishJobStore) => Promise<T>): Promise<T>;
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

/** The prices of paid platform calls in micro-USD; null for an operation without a known price. */
export interface OperationPrices {
  priceMicros(operation: string): number | null;
}
