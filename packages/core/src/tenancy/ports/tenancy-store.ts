import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { TrialStarter } from '../../billing/ports/subscription-store';
import type {
  Invitation,
  MemberRole,
  Membership,
  Organization,
  Workspace,
  WorkspaceSettings,
} from '../domain/types';

/**
 * The tenant of a unit of work. Row-level security limits every statement to it (architecture
 * 6.3). Without organizationId only the user-scoped reads work; invitationTokenHash opens the one
 * invitation with that hash.
 */
export interface TenancyScope {
  userId: string;
  organizationId?: string;
  workspaceId?: string;
  invitationTokenHash?: string;
}

export interface OrganizationRepository {
  create(organization: Organization): Promise<void>;
  findById(organizationId: string): Promise<Organization | null>;
}

export interface WorkspaceRepository {
  /** Returns false if the slug is taken, in any organization. */
  create(workspace: Workspace): Promise<boolean>;
  findById(organizationId: string, workspaceId: string): Promise<Workspace | null>;
  /** True if every id is a workspace of the organization. */
  allBelongTo(organizationId: string, workspaceIds: readonly string[]): Promise<boolean>;
  createSettings(workspaceId: string): Promise<void>;
  findSettings(workspaceId: string): Promise<WorkspaceSettings | null>;
  updateSettings(
    workspaceId: string,
    patch: Partial<Omit<WorkspaceSettings, 'workspaceId'>>,
  ): Promise<WorkspaceSettings>;
}

export interface MembershipRepository {
  create(membership: Membership): Promise<void>;
  findById(organizationId: string, membershipId: string): Promise<Membership | null>;
  findByUser(organizationId: string, userId: string): Promise<Membership | null>;
  findByEmail(organizationId: string, email: string): Promise<Membership | null>;
  /** Counts the owners and locks their rows until the transaction ends, so that two owners
   * cannot demote each other at the same time. */
  countOwnersForUpdate(organizationId: string): Promise<number>;
  updateRole(organizationId: string, membershipId: string, role: MemberRole): Promise<void>;
  delete(organizationId: string, membershipId: string): Promise<void>;
}

export interface InvitationRepository {
  create(invitation: Invitation): Promise<void>;
  findById(organizationId: string, invitationId: string): Promise<Invitation | null>;
  /** Needs the token hash in the scope; other invitations stay invisible. */
  findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  /** Revokes the open invitations to an address and returns how many there were. */
  revokeOpen(organizationId: string, email: string, at: Date): Promise<number>;
  /** Sets acceptedAt if the invitation is open and not expired at that time. False otherwise,
   * for example when a parallel request was faster. */
  markAccepted(organizationId: string, invitationId: string, at: Date): Promise<boolean>;
  /** Sets revokedAt if the invitation is still open. */
  revoke(organizationId: string, invitationId: string, at: Date): Promise<boolean>;
  /** A new token and a new expiry for an open invitation. */
  renew(organizationId: string, invitationId: string, tokenHash: string, expiresAt: Date): Promise<void>;
}

/** The repositories of one transaction. */
export interface TenancyStore {
  organizations: OrganizationRepository;
  workspaces: WorkspaceRepository;
  memberships: MembershipRepository;
  invitations: InvitationRepository;
  audit: AuditTrail;
  /** Billing: a new organization starts its trial in the same transaction. */
  trials: TrialStarter;
}

/** Runs work in one transaction with the scope set at its start. */
export interface TenancyUnitOfWork {
  run<T>(scope: TenancyScope, work: (store: TenancyStore) => Promise<T>): Promise<T>;
}
