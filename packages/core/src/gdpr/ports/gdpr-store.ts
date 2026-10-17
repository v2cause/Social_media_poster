import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { GdprRequest, GdprRequestDetails, GdprRequestKind } from '../domain/request';

// The ports of data protection (guide steps 8.1 and 8.2, ADR 0036). The owners ask for exports
// through the API as app_user in their organization; the worker role "gdpr" runs them as
// app_system, because an export reads every workspace of the organization.

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
}

/** The repositories of one transaction. */
export interface GdprStore {
  requests: GdprRequestRepository;
  audit: AuditTrail;
}

export interface GdprUnitOfWork {
  run<T>(scope: GdprScope, work: (store: GdprStore) => Promise<T>): Promise<T>;
}

/** Hands a request to the worker role "gdpr"; the id of the request keys the job. */
export interface GdprJobs {
  exportData(requestId: string): Promise<void>;
}

/** The requests as the worker role "gdpr" runs them (app_system). */
export interface GdprRequestRunner {
  /**
   * Marks a request as running if it waits or runs and is due at this moment; null otherwise.
   * A job that runs again after a failure claims it again.
   */
  claim(requestId: string, at: Date): Promise<GdprRequest | null>;
  /** Finishes a running request; false when it does not run any more, for example given up. */
  complete(
    requestId: string,
    at: Date,
    result: { details: GdprRequestDetails; objectKey?: string; expiresAt?: Date },
  ): Promise<boolean>;
  /** After the last attempt: the request failed, and a new one may be made. */
  fail(requestId: string, at: Date, details: GdprRequestDetails): Promise<void>;
  /** Gives up the requests of a kind that wait or run since before a moment; returns how many. */
  failStale(kind: GdprRequestKind, createdBefore: Date, at: Date): Promise<number>;
  /** The exports whose archive has expired, oldest first. */
  expiredExports(at: Date, limit: number): Promise<{ id: string; objectKey: string }[]>;
  /** The archive of an export is gone. */
  clearExport(requestId: string): Promise<void>;
}
