import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { XBrowserFlags } from '../domain/x-browser';

// The flags and risk acknowledgements of the X browser (guide step 6.1), implemented in @smp/db.
// The store of a workspace runs as app_user in its tenant; the admin store of the platform admins
// and of the circuit breaker runs as app_system, because the global and organization rows belong
// to no workspace.

export interface RiskAcknowledgement {
  id: string;
  workspaceId: string;
  userId: string;
  /** The name of the user; null when the user no longer exists. */
  userName: string | null;
  textVersion: string;
  textHash: string;
  locale: string;
  acceptedAt: Date;
}

export interface NewRiskAcknowledgement {
  id: string;
  workspaceId: string;
  userId: string;
  subject: string;
  textVersion: string;
  textHash: string;
  locale: string;
  ipAddress: string | null;
  acceptedAt: Date;
}

export interface XBrowserStore {
  /** The global, organization and workspace flags of the X browser. */
  flags(organizationId: string, workspaceId: string): Promise<XBrowserFlags>;
  setWorkspaceFlag(organizationId: string, workspaceId: string, enabled: boolean): Promise<void>;
  /** The newest acknowledgement of the subject that is not revoked, or null. */
  acknowledgement(workspaceId: string, subject: string): Promise<RiskAcknowledgement | null>;
  acknowledge(acknowledgement: NewRiskAcknowledgement): Promise<void>;
  /** Revokes the acknowledgements of the subject in force; returns how many. */
  revoke(workspaceId: string, subject: string, at: Date): Promise<number>;
  /**
   * Replaces the sealed session of the browser connection of X with this user (guide step 6.2);
   * false when the connection is gone, of another method or of another user.
   */
  replaceSession(
    workspaceId: string,
    connectionId: string,
    externalUserId: string,
    sealed: Uint8Array,
  ): Promise<boolean>;
  audit: AuditTrail;
}

export interface XBrowserScope {
  /** The acting user, for the audit log; absent for the gate of the worker. */
  userId?: string;
  organizationId: string;
  workspaceId: string;
}

export interface XBrowserUnitOfWork {
  run<T>(scope: XBrowserScope, work: (store: XBrowserStore) => Promise<T>): Promise<T>;
}

export interface XBrowserOrganization {
  id: string;
  name: string;
}

/** The switches of the platform admins and of the circuit breaker (app_system). */
export interface XBrowserAdminStore {
  globalFlag(): Promise<{ enabled: boolean; updatedAt: Date } | null>;
  setGlobalFlag(enabled: boolean): Promise<void>;
  /** Switches the global flag off unless it is off; true when this call switched it (guide step 6.5). */
  closeGlobalFlag(): Promise<boolean>;
  /** The organizations whose flag allows the X browser. */
  allowedOrganizations(): Promise<(XBrowserOrganization & { updatedAt: Date })[]>;
  /** The organization of a workspace; organizations have no slug of their own. */
  organizationOfWorkspace(workspaceSlug: string): Promise<XBrowserOrganization | null>;
  /** Sets the flag of the organization; false when the organization does not exist. */
  setOrganizationFlag(organizationId: string, allowed: boolean): Promise<boolean>;
}

/** The kill switch for the browser worker, which has no database: a key in Redis. */
export interface XBrowserKillSignal {
  set(active: boolean): Promise<void>;
}

/** An entry of the selector map that no longer matched X, as a browser worker reports it. */
export interface SelectorDrift {
  flow: string;
  selector: string;
  selectorsVersion: string;
}

/** The drifts of the last hour across all browser workers (guide step 6.5), in Redis. */
export interface SelectorDriftCounter {
  /** Counts a drift at the time given; returns the drifts of the hour up to it, this one included. */
  record(at: Date): Promise<number>;
  /** Forgets the drifts counted so far, once the breaker opened. */
  reset(): Promise<void>;
}

/** What the platform admins hear of the X browser, by email (guide step 6.5). */
export interface XBrowserAlerts {
  breakerOpened(alert: SelectorDrift & { drifts: number; at: Date }): Promise<void>;
  canaryFailed(alert: { missing: readonly string[]; selectorsVersion: string; at: Date }): Promise<void>;
}
