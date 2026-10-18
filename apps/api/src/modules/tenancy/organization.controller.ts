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
  Put,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { hours } from '@nestjs/throttler';
import { permissionsOf } from '@smp/contracts';
import {
  ChangeMemberRole,
  CreateWorkspace,
  EntitlementsService,
  InviteMember,
  LeaveOrganization,
  RemoveMember,
  ResendInvitation,
  RevokeInvitation,
  SetTwoFactorRequirement,
  systemClock,
  type OrganizationActor,
} from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import {
  AllowWhenDeleted,
  AllowWhenReadOnly,
  OrgScope,
  RequirePermission,
} from '../../common/decorators/access.decorators';
import { AccessCache } from '../../common/guards/access-cache';
import { Access, Actor, type RequestAccess } from '../../common/guards/request-access';
import { LimitPerUser } from '../../common/throttling/throttling';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import type { AuthenticatedRequest } from '../identity/auth.guard';
import { toBillingStateDto } from '../billing/billing.mappers';
import { toOrganizationDeletionDto } from '../gdpr/gdpr.mappers';
import {
  ChangeMemberRoleDto,
  CreateWorkspaceResponseDto,
  InvitationListDto,
  InviteMemberDto,
  InviteMemberResponseDto,
  MemberListDto,
  OrganizationContextDto,
  OrganizationSecurityDto,
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
    private readonly setTwoFactorRequirement: SetTwoFactorRequirement,
    private readonly createWorkspace: CreateWorkspace,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * The organization with the caller's role and permissions, the state of the subscription and,
   * while it waits for its erasure, its deletion.
   */
  @Get()
  @RequirePermission('org.read')
  @AllowWhenDeleted()
  @ZodResponse({ type: OrganizationContextDto })
  async context(@Access() access: RequestAccess): Promise<OrganizationContextDto> {
    return {
      organization: { id: access.organizationId, name: access.organizationName },
      role: access.role,
      permissions: permissionsOf(access.role),
      billing: toBillingStateDto(await this.entitlements.of(access.organizationId)),
      deletion: toOrganizationDeletionDto(access.deletedAt),
      security: { requireTwoFactor: access.requireTwoFactor },
    };
  }

  /**
   * An owner requires a second factor of every member, or drops the requirement (guide step
   * 8.4). The cached access of every member goes at once, so that the next request checks it.
   * Allowed while read-only: security does not wait for a payment.
   */
  @Put('security')
  @RequirePermission('org.security')
  @AllowWhenReadOnly()
  @ZodResponse({ type: OrganizationSecurityDto })
  async setSecurity(
    @Actor() actor: OrganizationActor,
    @Body() body: OrganizationSecurityDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<OrganizationSecurityDto> {
    const user = request.auth?.user as { twoFactorEnabled?: boolean | null } | undefined;
    const result = await this.setTwoFactorRequirement.execute({
      actor,
      required: body.requireTwoFactor,
      actorUsesTwoFactor: user?.twoFactorEnabled === true,
    });
    const members = await this.readModel.listMembers(actor);
    await this.cache.invalidateUsers(members.map((member) => member.userId));
    return result;
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
  @AllowWhenReadOnly()
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
  @AllowWhenReadOnly()
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

  @LimitPerUser(30, hours(1))
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

  @LimitPerUser(10, hours(1))
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
  @AllowWhenReadOnly()
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
