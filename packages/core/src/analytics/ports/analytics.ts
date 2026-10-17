import type { Platform } from '@smp/platform-rules';

import type { NormalizedPostMetrics } from '../../channels/ports/platform-adapter';
import type { TokenConnectionRepository } from '../../channels/ports/token-maintenance';
import type { ApiCostRepository, PublishJobTargetRepository } from '../../publishing/ports/publish-job';

// The ports of the analytics jobs (guide steps 5.2 and 5.3): the collector of post metrics and
// the daily account metrics run as app_user in the tenant of their account, the planner scans
// across workspaces as app_system and returns ids only.

export interface AnalyticsScope {
  organizationId: string;
  workspaceId: string;
}

/** A published variant whose next poll is due, claimed for one run of the collector. */
export interface DueVariant {
  id: string;
  externalPostId: string;
  externalUrl: string | null;
  publishedAt: Date;
  /** The poll that is due, from 0. */
  step: number;
}

/** What one poll of a variant found. */
export type VariantPoll =
  | {
      kind: 'metrics';
      variantId: string;
      publishedAt: Date;
      step: number;
      metrics: NormalizedPostMetrics;
      engagements: number | null;
      raw: unknown;
      mappingVersion: number;
      /** The next poll, or null after the last one. */
      next: { step: number; at: Date } | null;
    }
  /** The platform no longer knows the post: it gets the mark and no further polls. */
  | { kind: 'deleted'; variantId: string; publishedAt: Date };

export interface PostMetricsRepository {
  /**
   * Claims up to `limit` published variants of the account whose next poll is due at `now`, by
   * moving their next poll to `leaseUntil`: a second run skips them, and the variants of a run
   * that died are due again once the lease ends.
   */
  claimDue(
    workspaceId: string,
    accountId: string,
    now: Date,
    limit: number,
    leaseUntil: Date,
  ): Promise<DueVariant[]>;
  /** Moves the next poll of the variants to `at`, for example after a rate limit. */
  postpone(workspaceId: string, variantIds: readonly string[], at: Date): Promise<void>;
  /** Moves the next poll of all due variants of the account to `at`; returns how many. */
  postponeDue(workspaceId: string, accountId: string, now: Date, at: Date): Promise<number>;
  /** Ends the polls of all due variants of the account, for example once it is disconnected. */
  endDue(workspaceId: string, accountId: string, now: Date): Promise<number>;
  /**
   * Stores what a run found: a snapshot per poll, the latest numbers where they are newer and the
   * next poll; a deleted post gets its mark.
   */
  record(
    workspaceId: string,
    account: { id: string; platform: Platform },
    capturedAt: Date,
    polls: readonly VariantPoll[],
  ): Promise<void>;
}

/** The daily numbers of an account (architecture 8). */
export interface AccountDailyMetrics {
  workspaceId: string;
  accountId: string;
  platform: Platform;
  /** The day in the time zone of the workspace, YYYY-MM-DD. */
  day: string;
  followers: number | null;
  reach: number | null;
  profileViews: number | null;
  raw: unknown;
  mappingVersion: number;
  capturedAt: Date;
}

export interface AccountMetricsRepository {
  /** Stores the numbers of the account for the day; another poll of the day replaces them. */
  saveDaily(metrics: AccountDailyMetrics): Promise<void>;
}

export interface AnalyticsRollupRepository {
  /**
   * Fills the rollup of the workspace for the local days from `from` to `to` (YYYY-MM-DD, both
   * included) from the snapshots, the published posts and the daily numbers of the accounts;
   * rows of these days without data go. Returns the rows written.
   */
  rollUp(workspaceId: string, from: string, to: string): Promise<number>;
}

/** The repositories of one transaction of an analytics job. */
export interface AnalyticsStore {
  targets: PublishJobTargetRepository;
  connections: TokenConnectionRepository;
  workspaces: {
    /** The IANA time zone of the workspace. */
    timeZoneOf(workspaceId: string): Promise<string | null>;
  };
  postMetrics: PostMetricsRepository;
  accountMetrics: AccountMetricsRepository;
  rollups: AnalyticsRollupRepository;
  costs: ApiCostRepository;
}

export interface AnalyticsUnitOfWork {
  run<T>(scope: AnalyticsScope, work: (store: AnalyticsStore) => Promise<T>): Promise<T>;
}

/** An account with due polls, from the scan of the planner. */
export interface DueMetricsAccount {
  organizationId: string;
  workspaceId: string;
  accountId: string;
}

/** An account whose numbers of a day are missing, from the scan of the planner. */
export interface DueAccountDay extends DueMetricsAccount {
  /** The day before in the time zone of the workspace, YYYY-MM-DD. */
  day: string;
}

/** The scans of the analytics planner across workspaces (app_system); ids only. */
export interface MetricsPlanScanner {
  /** Accounts with at least one variant whose next poll is due, at most `limit`. */
  dueAccounts(now: Date, limit: number): Promise<DueMetricsAccount[]>;
  /**
   * Connected accounts whose numbers of the day before are missing once it is past 03:00 in the
   * time zone of their workspace, at most `limit`.
   */
  accountDaysDue(now: Date, limit: number): Promise<DueAccountDay[]>;
}
