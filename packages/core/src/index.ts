// Domain core: entities, use cases and ports. Framework-free by rule.

// Shared kernel
export { DomainError, NotPermittedError, type DomainErrorKind } from './shared/domain/errors';
export { systemClock, uuidV7Ids } from './shared/adapters/system';
export type { Clock } from './shared/ports/clock';
export type { IdGenerator } from './shared/ports/ids';

// Audit
export type { AuditEntry, AuditTrail } from './audit/ports/audit-trail';

// Notifications
export type { MailMessage, MailPort } from './notifications/ports/mail.port';

// Tenancy
export * from './tenancy/domain/errors';
export { INVITATION_TTL_MS, normalizeEmail } from './tenancy/domain/invitation';
export {
  assertCanGrantRole,
  assertCanManageMember,
  isManager,
  seesAllWorkspaces,
} from './tenancy/domain/roles';
export { SLUG_PATTERN, slugify } from './tenancy/domain/slug';
export {
  MEMBER_ROLES,
  MISSED_WINDOW_BEHAVIORS,
  type Invitation,
  type MemberRole,
  type Membership,
  type MissedWindowBehavior,
  type Organization,
  type OrganizationActor,
  type Workspace,
  type WorkspaceProfile,
  type WorkspaceSettings,
} from './tenancy/domain/types';
export type { InvitationMessage, InvitationNotifier } from './tenancy/ports/invitation-notifier';
export type { SecretTokens } from './tenancy/ports/secret-tokens';
export type {
  InvitationRepository,
  MembershipRepository,
  OrganizationRepository,
  TenancyScope,
  TenancyStore,
  TenancyUnitOfWork,
  WorkspaceRepository,
} from './tenancy/ports/tenancy-store';
export { AcceptInvitation, type AcceptInvitationInput } from './tenancy/application/accept-invitation';
export { ChangeMemberRole, type ChangeMemberRoleInput } from './tenancy/application/change-member-role';
export {
  CreateOrganization,
  type CreateOrganizationInput,
  type CreateOrganizationResult,
} from './tenancy/application/create-organization';
export { CreateWorkspace, type CreateWorkspaceInput } from './tenancy/application/create-workspace';
export type { TenancyDependencies } from './tenancy/application/dependencies';
export { InviteMember, type InviteMemberInput } from './tenancy/application/invite-member';
export { LeaveOrganization, type LeaveOrganizationInput } from './tenancy/application/leave-organization';
export {
  ResendInvitation,
  RevokeInvitation,
  type InvitationActionInput,
} from './tenancy/application/manage-invitation';
export { RemoveMember, type RemoveMemberInput } from './tenancy/application/remove-member';
export {
  UpdateWorkspaceSettings,
  type UpdateWorkspaceSettingsInput,
} from './tenancy/application/update-workspace-settings';
