import { z } from 'zod';

import { billingStateSchema } from './billing';
import { organizationDeletionSchema } from './gdpr';
import { localeSchema } from './locale';
import { PERMISSIONS, roleSchema } from './permissions';
import { timezoneSchema } from './timezone';

// Request and response shapes of the tenancy API (guide steps 1.6 and 1.9). The web forms use
// the same request schemas.

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null);

export const workspaceProfileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  timezone: timezoneSchema,
  contentLanguage: localeSchema,
  industry: optionalText(100),
  targetAudience: optionalText(500),
  goals: optionalText(500),
  contentPillars: z.array(text(40)).max(10).default([]),
});
export type WorkspaceProfileInput = z.input<typeof workspaceProfileSchema>;

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  workspace: workspaceProfileSchema,
});
export type CreateOrganizationRequest = z.input<typeof createOrganizationSchema>;

export const createOrganizationResponseSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  workspaceSlug: z.string(),
});

export const createWorkspaceResponseSchema = z.object({ workspaceId: z.uuid(), workspaceSlug: z.string() });

export const inviteMemberSchema = z.object({
  email: z.email().max(254),
  role: roleSchema,
  workspaceIds: z.array(z.uuid()).max(100).default([]),
});
export type InviteMemberRequest = z.input<typeof inviteMemberSchema>;

export const changeMemberRoleSchema = z.object({ role: roleSchema });

export const invitationTokenSchema = z.object({ token: z.string().min(16).max(128) });

export const AI_ROUTES = ['generate', 'refine', 'ideas', 'alt_text'] as const;
export const AI_EFFORTS = ['low', 'medium', 'high'] as const;

export const workspaceSettingsSchema = z.object({
  dryRun: z.boolean(),
  missedWindowBehavior: z.enum(['FAIL', 'POST_ANYWAY']),
  effortOverrides: z.partialRecord(z.enum(AI_ROUTES), z.enum(AI_EFFORTS)).nullable(),
});
export type WorkspaceSettingsDto = z.infer<typeof workspaceSettingsSchema>;

export const updateWorkspaceSettingsSchema = workspaceSettingsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'empty_patch' });

const workspaceSummarySchema = z.object({ id: z.uuid(), slug: z.string(), name: z.string() });

export const workspaceSchema = workspaceSummarySchema.extend({
  organizationId: z.uuid(),
  timezone: z.string(),
  contentLanguage: z.string(),
  industry: z.string().nullable(),
  targetAudience: z.string().nullable(),
  goals: z.string().nullable(),
  contentPillars: z.array(z.string()),
});
export type WorkspaceDto = z.infer<typeof workspaceSchema>;

/** One organization of the signed-in user with the workspaces the user may open. */
export const membershipSummarySchema = z.object({
  organizationId: z.uuid(),
  organizationName: z.string(),
  role: roleSchema,
  workspaces: z.array(workspaceSummarySchema),
});
export const myMembershipsSchema = z.object({ memberships: z.array(membershipSummarySchema) });
export type MyMemberships = z.infer<typeof myMembershipsSchema>;

/**
 * The workspace of a /w/:ws route with the caller's role and permissions. deletion is set while
 * the organization waits for its erasure (guide step 8.2); nothing else works then.
 */
export const workspaceContextSchema = z.object({
  workspace: workspaceSchema,
  organization: z.object({ id: z.uuid(), name: z.string() }),
  role: roleSchema,
  permissions: z.array(z.enum(PERMISSIONS)),
  billing: billingStateSchema,
  deletion: organizationDeletionSchema.nullable(),
});
export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

export const organizationContextSchema = z.object({
  organization: z.object({ id: z.uuid(), name: z.string() }),
  role: roleSchema,
  permissions: z.array(z.enum(PERMISSIONS)),
  billing: billingStateSchema,
  deletion: organizationDeletionSchema.nullable(),
});
export type OrganizationContext = z.infer<typeof organizationContextSchema>;

export const memberSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  workspaceIds: z.array(z.uuid()),
  joinedAt: z.iso.datetime(),
});
export const memberListSchema = z.object({ members: z.array(memberSchema) });
export type Member = z.infer<typeof memberSchema>;

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: roleSchema,
  workspaceIds: z.array(z.uuid()),
  invitedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
});
export const invitationListSchema = z.object({ invitations: z.array(invitationSchema) });
export type InvitationDto = z.infer<typeof invitationSchema>;

export const inviteMemberResponseSchema = z.object({ invitationId: z.uuid(), expiresAt: z.iso.datetime() });

/** What the holder of an invitation link sees before accepting. */
export const invitationPreviewSchema = z.object({
  organizationName: z.string(),
  invitedBy: z.string().nullable(),
  email: z.string(),
  role: roleSchema,
  expiresAt: z.iso.datetime(),
  status: z.enum(['open', 'expired', 'used']),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

export const acceptInvitationResponseSchema = z.object({
  organizationId: z.uuid(),
  workspaceSlug: z.string().nullable(),
});

export const workspaceListSchema = z.object({ workspaces: z.array(workspaceSchema) });
