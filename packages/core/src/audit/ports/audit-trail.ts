/**
 * One audit entry (guide step 1.7). The adapter adds actor, IP address and user agent from the
 * request context. Metadata never holds secrets, tokens or passwords.
 */
export interface AuditEntry {
  organizationId: string;
  workspaceId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, string | number | boolean | null | string[]>;
}

/** Writes audit entries in the transaction of the change they describe. */
export interface AuditTrail {
  record(entry: AuditEntry): Promise<void>;
}
