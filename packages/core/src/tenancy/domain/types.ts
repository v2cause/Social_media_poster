// Tenancy entities (architecture 6.2) as the use cases see them.

export const MEMBER_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MISSED_WINDOW_BEHAVIORS = ['FAIL', 'POST_ANYWAY'] as const;
export type MissedWindowBehavior = (typeof MISSED_WINDOW_BEHAVIORS)[number];

export interface Organization {
  id: string;
  name: string;
}

export interface WorkspaceProfile {
  name: string;
  timezone: string;
  contentLanguage: string;
  industry: string | null;
  targetAudience: string | null;
  goals: string | null;
  contentPillars: string[];
}

export interface Workspace extends WorkspaceProfile {
  id: string;
  organizationId: string;
  slug: string;
}

export interface WorkspaceSettings {
  workspaceId: string;
  dryRun: boolean;
  missedWindowBehavior: MissedWindowBehavior;
  effortOverrides: Record<string, string> | null;
}

export interface Membership {
  id: string;
  organizationId: string;
  userId: string;
  role: MemberRole;
  /** Restriction to these workspaces. Empty means every workspace of the organization. */
  workspaceIds: string[];
}

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: MemberRole;
  /** SHA-256 of the token. The token itself is only in the email link. */
  tokenHash: string;
  workspaceIds: string[];
  invitedById: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

/** The member acting in an organization, as the guards resolved it. */
export interface OrganizationActor {
  userId: string;
  organizationId: string;
  role: MemberRole;
}
