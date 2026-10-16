import type { Invitation, Membership, Workspace, WorkspaceSettings } from '@smp/core';
import { z } from 'zod';

import type * as Prisma from '../generated/prisma/client';

// Prisma rows to the entities of the core.

export const toWorkspace = (row: Prisma.Workspace): Workspace => ({
  id: row.id,
  organizationId: row.organizationId,
  slug: row.slug,
  name: row.name,
  timezone: row.timezone,
  contentLanguage: row.contentLanguage,
  industry: row.industry,
  targetAudience: row.targetAudience,
  goals: row.goals,
  contentPillars: row.contentPillars,
});

export const toMembership = (
  row: Prisma.Membership & { workspaces: { workspaceId: string }[] },
): Membership => ({
  id: row.id,
  organizationId: row.organizationId,
  userId: row.userId,
  role: row.role,
  workspaceIds: row.workspaces.map((entry) => entry.workspaceId).sort(),
});

export const toInvitation = (row: Prisma.Invitation): Invitation => ({
  id: row.id,
  organizationId: row.organizationId,
  email: row.email,
  role: row.role,
  tokenHash: row.tokenHash,
  workspaceIds: row.workspaceIds,
  invitedById: row.invitedById,
  expiresAt: row.expiresAt,
  acceptedAt: row.acceptedAt,
  revokedAt: row.revokedAt,
});

// The JSON column is validated like every other external input (guide B.1).
const effortOverrides = z.record(z.string(), z.string()).nullable();

export const toSettings = (row: Prisma.WorkspaceSettings): WorkspaceSettings => ({
  workspaceId: row.workspaceId,
  dryRun: row.dryRun,
  missedWindowBehavior: row.missedWindowBehavior,
  effortOverrides: effortOverrides.parse(row.effortOverrides ?? null),
});
