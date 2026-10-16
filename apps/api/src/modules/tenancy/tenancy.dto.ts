import {
  acceptInvitationResponseSchema,
  changeMemberRoleSchema,
  createOrganizationResponseSchema,
  createOrganizationSchema,
  createWorkspaceResponseSchema,
  invitationListSchema,
  invitationPreviewSchema,
  invitationTokenSchema,
  inviteMemberResponseSchema,
  inviteMemberSchema,
  memberListSchema,
  myMembershipsSchema,
  organizationContextSchema,
  updateWorkspaceSettingsSchema,
  workspaceContextSchema,
  workspaceListSchema,
  workspaceProfileSchema,
  workspaceSettingsSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of the tenancy API. The schemas live in @smp/contracts, where the
// web forms use them too.

export class CreateOrganizationDto extends createZodDto(createOrganizationSchema) {}
export class CreateOrganizationResponseDto extends createZodDto(createOrganizationResponseSchema) {}
export class WorkspaceProfileDto extends createZodDto(workspaceProfileSchema) {}
export class CreateWorkspaceResponseDto extends createZodDto(createWorkspaceResponseSchema) {}
export class InviteMemberDto extends createZodDto(inviteMemberSchema) {}
export class InviteMemberResponseDto extends createZodDto(inviteMemberResponseSchema) {}
export class ChangeMemberRoleDto extends createZodDto(changeMemberRoleSchema) {}
export class InvitationTokenDto extends createZodDto(invitationTokenSchema) {}
export class InvitationPreviewDto extends createZodDto(invitationPreviewSchema) {}
export class AcceptInvitationResponseDto extends createZodDto(acceptInvitationResponseSchema) {}
export class MyMembershipsDto extends createZodDto(myMembershipsSchema) {}
export class OrganizationContextDto extends createZodDto(organizationContextSchema) {}
export class WorkspaceContextDto extends createZodDto(workspaceContextSchema) {}
export class MemberListDto extends createZodDto(memberListSchema) {}
export class InvitationListDto extends createZodDto(invitationListSchema) {}
export class WorkspaceListDto extends createZodDto(workspaceListSchema) {}
export class WorkspaceSettingsDto extends createZodDto(workspaceSettingsSchema) {}
export class UpdateWorkspaceSettingsDto extends createZodDto(updateWorkspaceSettingsSchema) {}
