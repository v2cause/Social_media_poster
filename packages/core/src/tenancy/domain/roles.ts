import { RoleChangeForbiddenError } from './errors';
import type { MemberRole } from './types';

/** Owners and admins manage members, workspaces and settings (architecture 10). */
export const isManager = (role: MemberRole): boolean => role === 'OWNER' || role === 'ADMIN';

/** Only an owner may grant the owner role; an admin may grant every other role. */
export function assertCanGrantRole(actor: MemberRole, granted: MemberRole): void {
  if (granted === 'OWNER' && actor !== 'OWNER') {
    throw new RoleChangeForbiddenError();
  }
}

/** Only an owner may change or remove another owner. */
export function assertCanManageMember(actor: MemberRole, member: MemberRole): void {
  if (member === 'OWNER' && actor !== 'OWNER') {
    throw new RoleChangeForbiddenError();
  }
}

/** Members with these roles see every workspace, whatever their restriction says. */
export const seesAllWorkspaces = (role: MemberRole): boolean => isManager(role);
