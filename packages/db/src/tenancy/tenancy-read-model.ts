import type { MemberRole, Workspace, WorkspaceSettings } from '@smp/core';

import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { toSettings, toWorkspace } from './mappers';

// The read side of the tenancy context: what the guards, the team page and the workspace
// switcher show. Every method names its tenant explicitly and runs in that scope.

/** The organization of a route; deletedAt is set while it waits for its erasure (step 8.2). */
export interface AccessedOrganization {
  id: string;
  name: string;
  deletedAt: Date | null;
}

export interface WorkspaceAccess {
  workspace: Workspace;
  organization: AccessedOrganization;
  role: MemberRole;
}

export interface OrganizationAccess {
  organization: AccessedOrganization;
  role: MemberRole;
}

export interface UserMembershipView {
  organizationId: string;
  organizationName: string;
  role: MemberRole;
  workspaces: { id: string; slug: string; name: string }[];
}

export interface MemberView {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  workspaceIds: string[];
  joinedAt: Date;
}

export interface InvitationView {
  id: string;
  email: string;
  role: MemberRole;
  workspaceIds: string[];
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface InvitationPreviewView {
  organizationName: string;
  invitedBy: string | null;
  email: string;
  role: MemberRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface InvitationMailContext {
  organizationName: string;
  inviterName: string;
  /** The invitee's language if the address already has an account, else the inviter's. */
  locale: string;
}

export class TenancyReadModel {
  constructor(private readonly base: PrismaClient) {}

  /** The organizations of a user and the workspaces the user may open (user scope). */
  membershipsOfUser(userId: string): Promise<UserMembershipView[]> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      const memberships = await tx.membership.findMany({
        where: { userId },
        include: { organization: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const workspaces = await tx.workspace.findMany({
        where: { organizationId: { in: memberships.map((m) => m.organizationId) } },
        select: { id: true, slug: true, name: true, organizationId: true },
        orderBy: { name: 'asc' },
      });
      return memberships.map((membership) => ({
        organizationId: membership.organizationId,
        organizationName: membership.organization.name,
        role: membership.role,
        workspaces: workspaces
          .filter((workspace) => workspace.organizationId === membership.organizationId)
          .map(({ id, slug, name }) => ({ id, slug, name })),
      }));
    });
  }

  /** Resolves /w/:ws for a user. Null for unknown slugs and for workspaces the user may not open. */
  resolveWorkspace(userId: string, slug: string): Promise<WorkspaceAccess | null> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      const workspace = await tx.workspace.findUnique({
        where: { slug },
        include: { organization: { select: { id: true, name: true, deletedAt: true } } },
      });
      if (!workspace) {
        return null;
      }
      const membership = await tx.membership.findFirst({
        where: { organizationId: workspace.organizationId, userId },
        select: { role: true },
      });
      return membership
        ? { workspace: toWorkspace(workspace), organization: workspace.organization, role: membership.role }
        : null;
    });
  }

  /** Resolves /org/:org for a user. Null if the user is no member. */
  resolveOrganization(userId: string, organizationId: string): Promise<OrganizationAccess | null> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { organizationId, userId },
        include: { organization: { select: { id: true, name: true, deletedAt: true } } },
      });
      return membership ? { organization: membership.organization, role: membership.role } : null;
    });
  }

  listMembers(scope: { userId: string; organizationId: string }): Promise<MemberView[]> {
    return withTenantTx(this.base, scope, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { organizationId: scope.organizationId },
        include: {
          user: { select: { name: true, email: true } },
          workspaces: { select: { workspaceId: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.user.name,
        email: row.user.email,
        role: row.role,
        workspaceIds: row.workspaces.map((entry) => entry.workspaceId).sort(),
        joinedAt: row.createdAt,
      }));
    });
  }

  /** Invitations that were neither accepted nor revoked, expired ones included. */
  listOpenInvitations(scope: { userId: string; organizationId: string }): Promise<InvitationView[]> {
    return withTenantTx(this.base, scope, async (tx) => {
      const rows = await tx.invitation.findMany({
        where: { organizationId: scope.organizationId, acceptedAt: null, revokedAt: null },
        include: { invitedBy: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        workspaceIds: row.workspaceIds,
        invitedBy: row.invitedBy.name,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }));
    });
  }

  listWorkspaces(scope: { userId: string; organizationId: string }): Promise<Workspace[]> {
    return withTenantTx(this.base, scope, async (tx) => {
      const rows = await tx.workspace.findMany({
        where: { organizationId: scope.organizationId },
        orderBy: { name: 'asc' },
      });
      return rows.map(toWorkspace);
    });
  }

  workspaceSettings(scope: {
    userId: string;
    organizationId: string;
    workspaceId: string;
  }): Promise<WorkspaceSettings | null> {
    return withTenantTx(this.base, scope, async (tx) => {
      const row = await tx.workspaceSettings.findUnique({ where: { workspaceId: scope.workspaceId } });
      return row ? toSettings(row) : null;
    });
  }

  /** Names and language for the invitation email (guide step 1.8). */
  invitationMailContext(
    scope: { userId: string; organizationId: string },
    email: string,
  ): Promise<InvitationMailContext> {
    return withTenantTx(this.base, scope, async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: scope.organizationId },
        select: { name: true },
      });
      const inviter = await tx.user.findUnique({
        where: { id: scope.userId },
        select: { name: true, locale: true },
      });
      const invitee = await tx.user.findUnique({ where: { email }, select: { locale: true } });
      return {
        organizationName: organization?.name ?? '',
        inviterName: inviter?.name ?? '',
        locale: invitee?.locale ?? inviter?.locale ?? 'de',
      };
    });
  }

  /** What the holder of an invitation link may see. Needs nothing but the token hash. */
  invitationPreview(tokenHash: string): Promise<InvitationPreviewView | null> {
    return withTenantTx(this.base, { invitationTokenHash: tokenHash }, async (tx) => {
      const row = await tx.invitation.findUnique({
        where: { tokenHash },
        include: { organization: { select: { name: true } }, invitedBy: { select: { name: true } } },
      });
      return row
        ? {
            organizationName: row.organization.name,
            invitedBy: row.invitedBy.name,
            email: row.email,
            role: row.role,
            expiresAt: row.expiresAt,
            acceptedAt: row.acceptedAt,
            revokedAt: row.revokedAt,
          }
        : null;
    });
  }
}
