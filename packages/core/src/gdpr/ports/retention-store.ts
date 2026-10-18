// What the retention periods remove every night (guide step 8.3, ADR 0038), as app_system across
// organizations. Every method works on at most limit rows and returns how many it changed, so that
// no statement holds its locks for long; fewer than limit means there is nothing more to do.

export interface RetentionStore {
  /** Clears the input and the output of AI generations created before the moment. */
  clearAiRawData(createdBefore: Date, limit: number): Promise<number>;
  /** Deletes webhook events processed before the moment; waiting ones stay. */
  deleteProcessedWebhooks(processedBefore: Date, limit: number): Promise<number>;
  /**
   * Clears the connection data of before the moment: the IP address and the user agent of the
   * entries of the audit log created before it, the sessions that expired before it and the
   * counters of the rate limits last used before it. At most limit rows per table; returns the
   * rows of all tables.
   */
  clearConnectionData(before: Date, limit: number): Promise<number>;
  /**
   * Deletes the accounts created before the moment whose address was never verified, with their
   * sessions and credentials. An account with a membership stays.
   */
  deleteUnverifiedUsers(createdBefore: Date, limit: number): Promise<number>;
  /** The organizations with workspaces after the cursor, ordered by id. */
  organizations(after: string | null, limit: number): Promise<string[]>;
  /**
   * Deletes the metrics of the workspaces of an organization from before the moment: the
   * snapshots of posts by the moment they were taken, the numbers of accounts and the rollups by
   * their day. At most limit rows per table; returns the rows of all tables.
   */
  deleteMetrics(organizationId: string, before: Date, limit: number): Promise<number>;
}
