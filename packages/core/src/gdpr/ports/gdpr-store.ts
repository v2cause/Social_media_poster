import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { GdprRequest, GdprRequestDetails, GdprRequestKind } from '../domain/request';

// The ports of data protection (guide steps 8.1 and 8.2, ADR 0036 and 0037). The owners ask for
// exports and erasures through the API as app_user in their organization; the worker role "gdpr"
// runs them as app_system, because an export reads every workspace of the organization and an
// erasure outlives it.

/** The tenant of a unit of work: the owner in the organization. */
export interface GdprScope {
  userId: string;
  organizationId: string;
}

export interface GdprRequestRepository {
  /** False when a request of the same kind waits or runs already, for example from a parallel call. */
  create(request: GdprRequest): Promise<boolean>;
  /** The request of a kind that waits or runs, or null. */
  findOpen(organizationId: string, kind: GdprRequestKind): Promise<GdprRequest | null>;
  find(organizationId: string, requestId: string): Promise<GdprRequest | null>;
  /** The latest requests of a kind, newest first. */
  listRecent(organizationId: string, kind: GdprRequestKind, limit: number): Promise<GdprRequest[]>;
  /** Takes back a waiting erasure; false when it does not wait any more. */
  cancel(organizationId: string, requestId: string, at: Date): Promise<boolean>;
}

export interface DeletableOrganization {
  id: string;
  name: string;
  deletedAt: Date | null;
  workspaceIds: string[];
  /** A paid subscription that renews at the end of its period. */
  renewingSubscription: boolean;
}

export interface OrganizationDeletion {
  find(organizationId: string): Promise<DeletableOrganization | null>;
  markDeleted(organizationId: string, at: Date): Promise<void>;
  restore(organizationId: string): Promise<void>;
}

/** The repositories of one transaction. */
export interface GdprStore {
  requests: GdprRequestRepository;
  organizations: OrganizationDeletion;
  audit: AuditTrail;
}

export interface GdprUnitOfWork {
  run<T>(scope: GdprScope, work: (store: GdprStore) => Promise<T>): Promise<T>;
}

/** Hands a request to the worker role "gdpr"; the id of the request keys the job. */
export interface GdprJobs {
  exportData(requestId: string): Promise<void>;
  erase(requestId: string): Promise<void>;
}

/**
 * The paid subscription of an organization in deletion ends with its period, so that the owners
 * pay no further period; taking the deletion back lets it renew again. Null without Stripe.
 */
export interface DeletionBilling {
  endWithPeriod(organizationId: string, end: boolean): Promise<void>;
}

/** The requests as the worker role "gdpr" runs them (app_system). */
export interface GdprRequestRunner {
  /**
   * Marks a request as running if it waits or runs and is due at this moment; null otherwise.
   * A job that runs again after a failure claims it again.
   */
  claim(requestId: string, at: Date): Promise<GdprRequest | null>;
  /**
   * Finishes a running request; false when it does not run any more, for example given up. With
   * anonymize the request forgets who asked, as the erasure leaves it.
   */
  complete(
    requestId: string,
    at: Date,
    result: { details: GdprRequestDetails; objectKey?: string; expiresAt?: Date; anonymize?: boolean },
  ): Promise<boolean>;
  /** After the last attempt: the request failed, and a new one may be made. */
  fail(requestId: string, at: Date, details: GdprRequestDetails): Promise<void>;
  /** Gives up the requests of a kind that wait or run since before a moment; returns how many. */
  failStale(kind: GdprRequestKind, createdBefore: Date, at: Date): Promise<number>;
  /**
   * The erasures that wait and are due, and those that run since before stuckSince, whose job was
   * lost; oldest first.
   */
  dueErasures(at: Date, stuckSince: Date, limit: number): Promise<string[]>;
  /** The exports whose archive has expired, oldest first. */
  expiredExports(at: Date, limit: number): Promise<{ id: string; objectKey: string }[]>;
  /** The archive of an export is gone. */
  clearExport(requestId: string): Promise<void>;
}
