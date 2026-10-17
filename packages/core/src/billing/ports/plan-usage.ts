// What an organization uses of the limits its plan counts across all its workspaces (guide step
// 7.4, ADR 0035). The counts read what is committed: two requests that add at the same moment can
// pass a limit by one, which a plan accepts like the resources that stay after a downgrade.

export interface PlanUsage {
  /** The connected accounts in all workspaces. */
  socialAccounts(organizationId: string): Promise<number>;
  /**
   * The posts that go out in the calendar month (UTC) of a moment, planned or published, without
   * one variant, which is the one being planned.
   */
  postsInMonth(organizationId: string, at: Date, exceptVariantId: string | null): Promise<number>;
  /** The originals of the media libraries of all workspaces, in bytes. */
  storageBytes(organizationId: string): Promise<number>;
  /** The X API costs of the calendar month (UTC) of a moment, in micro-USD. */
  xApiSpendMicros(organizationId: string, at: Date): Promise<number>;
}
