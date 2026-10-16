import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { permissionsOf } from '@smp/contracts';
import {
  ChangeMemberRole,
  CreateWorkspace,
  InviteMember,
  LeaveOrganization,
  RemoveMember,
  ResendInvitation,
  RevokeInvitation,
  systemClock,
  type OrganizationActor,
} from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import { OrgScope, RequirePermission } from '../../common/decorators/access.decorators';
import { AccessCache } from '../../common/guards/access-cache';
import { Access, Actor, type RequestAccess } from '../../common/guards/request-access';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import {
  ChangeMemberRoleDto,
  CreateWorkspaceResponseDto,
  InvitationListDto,
  InviteMemberDto,
  InviteMemberResponseDto,
  MemberListDto,
  OrganizationContextDto,
  WorkspaceListDto,
  WorkspaceProfileDto,
} from './tenancy.dto';

const id = new ParseUUIDPipe();

/** Organization, members and invitations under /api/org/:org (guide step 1.6). */
@ApiTags('organizations')
@OrgScope()
@Controller('org/:org')
export class OrganizationController {
  constructor(
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
    private readonly cache: AccessCache,
    private readonly changeRole: ChangeMemberRole,
    private readonly removeMemberUseCase: RemoveMember,
    private readonly leaveOrganization: LeaveOrganization,
    private readonly inviteMember: InviteMember,
    private readonly resendInvitationUseCase: ResendInvitation,
    private readonly revokeInvitationUseCase: RevokeInvitation,
    private readonly createWorkspace: CreateWorkspace,
  ) {}

  @Get()
  @RequirePermission('org.read')
  @ZodResponse({ type: OrganizationContextDto })
  context(@Access() access: RequestAccess): OrganizationContextDto {
    return {
      organization: { id: access.organizationId, name: access.organizationName },
      role: access.role,
      permissions: permissionsOf(access.role),
    };
  }

  @Get('members')
  @RequirePermission('member.read')
  @ZodResponse({ type: MemberListDto })
  async members(@Actor() actor: OrganizationActor): Promise<MemberListDto> {
    const members = await this.readModel.listMembers(actor);
    return { members: members.map((member) => ({ ...member, joinedAt: member.joinedAt.toISOString() })) };
  }

  @Patch('members/:membershipId')
  @RequirePermission('member.manage')
  @HttpCode(204)
  async changeMemberRole(
    @Actor() actor: OrganizationActor,
    @Param('membershipId', id) membershipId: string,
    @Body() body: ChangeMemberRoleDto,
  ): Promise<void> {
    const member = await this.changeRole.execute({ actor, membershipId, role: body.role });
    await this.cache.invalidateUser(member.userId);
  }

  @Delete('members/:membershipId')
  @RequirePermission('member.manage')
  @HttpCode(204)
  async removeMember(
    @Actor() actor: OrganizationActor,
    @Param('membershipId', id) membershipId: string,
  ): Promise<void> {
    const { userId } = await this.removeMemberUseCase.execute({ actor, membershipId });
    await this.cache.invalidateUser(userId);
  }

  @Post('leave')
  @RequirePermission('org.read')
  @HttpCode(204)
  async leave(@Actor() actor: OrganizationActor): Promise<void> {
    await this.leaveOrganization.execute({ actor });
    await this.cache.invalidateUser(actor.userId);
  }

  @Get('invitations')
  @RequirePermission('member.manage')
  @ZodResponse({ type: InvitationListDto })
  async invitations(@Actor() actor: OrganizationActor): Promise<InvitationListDto> {
    const now = systemClock.now();
    const invitations = await this.readModel.listOpenInvitations(actor);
    return {
      invitations: invitations.map((invitation) => ({
        ...invitation,
        createdAt: invitation.createdAt.toISOString(),
        expiresAt: invitation.expiresAt.toISOString(),
        expired: invitation.expiresAt <= now,
      })),
    };
  }

  @Post('invitations')
  @RequirePermission('member.manage')
  @ZodResponse({ status: 201, type: InviteMemberResponseDto })
  async invite(
    @Actor() actor: OrganizationActor,
    @Body() body: InviteMemberDto,
  ): Promise<InviteMemberResponseDto> {
    const result = await this.inviteMember.execute({
      actor,
      email: body.email,
      role: body.role,
      workspaceIds: body.workspaceIds,
    });
    return { invitationId: result.invitationId, expiresAt: result.expiresAt.toISOString() };
  }

  @Post('invitations/:invitationId/resend')
  @RequirePermission('member.manage')
  @HttpCode(204)
  async resendInvitation(
    @Actor() actor: OrganizationActor,
    @Param('invitationId', id) invitationId: string,
  ): Promise<void> {
    await this.resendInvitationUseCase.execute({ actor, invitationId });
  }

  @Delete('invitations/:invitationId')
  @RequirePermission('member.manage')
  @HttpCode(204)
  async revokeInvitation(
    @Actor() actor: OrganizationActor,
    @Param('invitationId', id) invitationId: string,
  ): Promise<void> {
    await this.revokeInvitationUseCase.execute({ actor, invitationId });
  }

  @Get('workspaces')
  @RequirePermission('workspace.manage')
  @ZodResponse({ type: WorkspaceListDto })
  async workspaces(@Actor() actor: OrganizationActor): Promise<WorkspaceListDto> {
    return { workspaces: await this.readModel.listWorkspaces(actor) };
  }

  @Post('workspaces')
  @RequirePermission('workspace.manage')
  @ZodResponse({ status: 201, type: CreateWorkspaceResponseDto })
  addWorkspace(
    @Actor() actor: OrganizationActor,
    @Body() body: WorkspaceProfileDto,
  ): Promise<CreateWorkspaceResponseDto> {
    return this.createWorkspace.execute({ actor, profile: body });
  }
}
