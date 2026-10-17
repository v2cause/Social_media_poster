import { z } from 'zod';

// The permission matrix (architecture 10). The API enforces it with @RequirePermission(); the web
// app uses can() to hide actions a role may not take. The server checks every time regardless.

export const ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

const READ = [
  'org.read',
  'member.read',
  'workspace.read',
  'post.read',
  'analytics.read',
  'idea.read',
] as const;
const WRITE = [
  'post.write',
  'post.schedule',
  'post.publish',
  'post.delete',
  'media.write',
  'ai.use',
  'idea.write',
] as const;
const MANAGE = [
  'member.manage',
  'workspace.manage',
  'settings.manage',
  'account.manage',
  'brand_voice.manage',
  'x_browser.enable',
  'audit.read',
] as const;
const OWN = ['billing.manage', 'org.export', 'org.delete', 'ownership.transfer'] as const;

export const PERMISSIONS = [...READ, ...WRITE, ...MANAGE, ...OWN] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS = {
  OWNER: [...READ, ...WRITE, ...MANAGE, ...OWN],
  ADMIN: [...READ, ...WRITE, ...MANAGE],
  EDITOR: [...READ, ...WRITE],
  VIEWER: [...READ],
} as const satisfies Record<Role, readonly Permission[]>;

/** True if the role grants the permission. */
export const can = (role: Role, permission: Permission): boolean =>
  (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission);

/** Every permission of a role, for the UI. */
export const permissionsOf = (role: Role): Permission[] => [...ROLE_PERMISSIONS[role]];
