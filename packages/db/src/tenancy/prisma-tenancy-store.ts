import type { TenancyScope, TenancyStore } from '@smp/core';

import { prismaAuditTrail, type RequestOrigin } from '../audit/prisma-audit-trail';
import { Prisma } from '../generated/prisma/client';
import type { TenantTransaction } from '../tenant-context';
import { toInvitation, toMembership, toSettings, toWorkspace } from './mappers';

export type { RequestOrigin } from '../audit/prisma-audit-trail';

const withWorkspaces = { workspaces: { select: { workspaceId: true } } } as const;

/**
 * The repositories of the tenancy context on one transaction. Every method filters by the tenant
 * explicitly; row-level security limits it to the scope of the transaction as well.
 */
export function createPrismaTenancyStore(
  tx: TenantTransaction,
  scope: TenancyScope,
  origin: RequestOrigin,
): TenancyStore {
  return {
    organizations: {
      async create(organization) {
        await tx.organization.create({ data: { id: organization.id, name: organization.name } });
      },
      async findById(organizationId) {
        const row = await tx.organization.findUnique({ where: { id: organizationId } });
        return row ? { id: row.id, name: row.name } : null;
      },
    },

    workspaces: {
      async create(workspace) {
        // ON CONFLICT DO NOTHING: a taken slug must not abort the transaction (ADR 0010).
        const created = await tx.workspace.createManyAndReturn({
          data: [
            {
              id: workspace.id,
              organizationId: workspace.organizationId,
              slug: workspace.slug,
              name: workspace.name,
              timezone: workspace.timezone,
              contentLanguage: workspace.contentLanguage,
              industry: workspace.industry,
              targetAudience: workspace.targetAudience,
              goals: workspace.goals,
              contentPillars: workspace.contentPillars,
            },
          ],
          skipDuplicates: true,
        });
        return created.length === 1;
      },
      async findById(organizationId, workspaceId) {
        const row = await tx.workspace.findFirst({ where: { id: workspaceId, organizationId } });
        return row ? toWorkspace(row) : null;
      },
      async allBelongTo(organizationId, workspaceIds) {
        const unique = [...new Set(workspaceIds)];
        const count = await tx.workspace.count({ where: { organizationId, id: { in: unique } } });
        return count === unique.length;
      },
      async createSettings(workspaceId) {
        await tx.workspaceSettings.create({ data: { workspaceId } });
      },
      async findSettings(workspaceId) {
        const row = await tx.workspaceSettings.findUnique({ where: { workspaceId } });
        return row ? toSettings(row) : null;
      },
      async updateSettings(workspaceId, patch) {
        const row = await tx.workspaceSettings.update({
          where: { workspaceId },
          data: {
            dryRun: patch.dryRun,
            missedWindowBehavior: patch.missedWindowBehavior,
            effortOverrides:
              patch.effortOverrides === undefined
                ? undefined
                : patch.effortOverrides === null
                  ? Prisma.DbNull
                  : patch.effortOverrides,
          },
        });
        return toSettings(row);
      },
    },

    memberships: {
      async create(membership) {
        await tx.membership.create({
          data: {
            id: membership.id,
            organizationId: membership.organizationId,
            userId: membership.userId,
            role: membership.role,
            workspaces: {
              create: membership.workspaceIds.map((workspaceId) => ({
                workspaceId,
                organizationId: membership.organizationId,
              })),
            },
          },
        });
      },
      async findById(organizationId, membershipId) {
        const row = await tx.membership.findFirst({
          where: { id: membershipId, organizationId },
          include: withWorkspaces,
        });
        return row ? toMembership(row) : null;
      },
      async findByUser(organizationId, userId) {
        const row = await tx.membership.findFirst({
          where: { organizationId, userId },
          include: withWorkspaces,
        });
        return row ? toMembership(row) : null;
      },
      async findByEmail(organizationId, email) {
        const row = await tx.membership.findFirst({
          where: { organizationId, user: { email } },
          include: withWorkspaces,
        });
        return row ? toMembership(row) : null;
      },
      async countOwnersForUpdate(organizationId) {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM membership
           WHERE organization_id = ${organizationId}::uuid AND role = 'OWNER'
           FOR UPDATE`;
        return rows.length;
      },
      async updateRole(organizationId, membershipId, role) {
        await tx.membership.updateMany({ where: { id: membershipId, organizationId }, data: { role } });
      },
      async delete(organizationId, membershipId) {
        await tx.membership.deleteMany({ where: { id: membershipId, organizationId } });
      },
    },

    invitations: {
      async create(invitation) {
        await tx.invitation.create({
          data: {
            id: invitation.id,
            organizationId: invitation.organizationId,
            email: invitation.email,
            role: invitation.role,
            tokenHash: invitation.tokenHash,
            workspaceIds: invitation.workspaceIds,
            invitedById: invitation.invitedById,
            expiresAt: invitation.expiresAt,
          },
        });
      },
      async findById(organizationId, invitationId) {
        const row = await tx.invitation.findFirst({ where: { id: invitationId, organizationId } });
        return row ? toInvitation(row) : null;
      },
      async findByTokenHash(tokenHash) {
        const row = await tx.invitation.findUnique({ where: { tokenHash } });
        return row ? toInvitation(row) : null;
      },
      async revokeOpen(organizationId, email, at) {
        const { count } = await tx.invitation.updateMany({
          where: { organizationId, email, acceptedAt: null, revokedAt: null },
          data: { revokedAt: at },
        });
        return count;
      },
      async markAccepted(organizationId, invitationId, at) {
        const { count } = await tx.invitation.updateMany({
          where: {
            id: invitationId,
            organizationId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: at },
          },
          data: { acceptedAt: at },
        });
        return count === 1;
      },
      async revoke(organizationId, invitationId, at) {
        const { count } = await tx.invitation.updateMany({
          where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
          data: { revokedAt: at },
        });
        return count === 1;
      },
      async renew(organizationId, invitationId, tokenHash, expiresAt) {
        await tx.invitation.updateMany({
          where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
          data: { tokenHash, expiresAt },
        });
      },
    },

    audit: prismaAuditTrail(tx, scope.userId, origin),
  };
}
