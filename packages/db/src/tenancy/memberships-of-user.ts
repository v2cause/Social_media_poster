import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The organizations of one user across all tenants, for operators (guide step 8.7): before an
// operator removes a lost second factor, an owner of each organization of the person confirms
// it. The scan names IDs, roles and counts only, never an address or a name.

export interface UserMembership {
  organizationId: string;
  role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
  /** The owners of the organization besides the user. */
  otherOwners: number;
  requireTwoFactor: boolean;
}

export function membershipsOfUser(system: SystemPrismaClient, userId: string): Promise<UserMembership[]> {
  return runInSystemScope(async () => {
    const memberships = await system.membership.findMany({
      where: { userId, organization: { deletedAt: null } },
      select: {
        organizationId: true,
        role: true,
        organization: {
          select: {
            requireTwoFactor: true,
            _count: { select: { memberships: { where: { role: 'OWNER', userId: { not: userId } } } } },
          },
        },
      },
      orderBy: { organizationId: 'asc' },
    });
    return memberships.map((membership) => ({
      organizationId: membership.organizationId,
      role: membership.role,
      otherOwners: membership.organization._count.memberships,
      requireTwoFactor: membership.organization.requireTwoFactor,
    }));
  });
}
