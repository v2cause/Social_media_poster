import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { permissionsOf } from '@smp/contracts';
import { EntitlementsService, UpdateWorkspaceSettings, WorkspaceNotFoundError } from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import {
  AllowWhenDeleted,
  RequirePermission,
  WorkspaceScope,
} from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import { toBillingStateDto } from '../billing/billing.mappers';
import { toOrganizationDeletionDto } from '../gdpr/gdpr.mappers';
import { UpdateWorkspaceSettingsDto, WorkspaceContextDto, WorkspaceSettingsDto } from './tenancy.dto';

type WorkspaceAccess = RequestAccess & { workspaceId: string };

function workspaceOf(access: RequestAccess): WorkspaceAccess {
  if (!access.workspaceId) {
    throw new WorkspaceNotFoundError();
  }
  return { ...access, workspaceId: access.workspaceId };
}

/** The workspace of /api/w/:ws and its settings. */
@ApiTags('workspaces')
@WorkspaceScope()
@Controller('w/:ws')
export class WorkspaceController {
  constructor(
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
    private readonly updateSettingsUseCase: UpdateWorkspaceSettings,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * The workspace with the caller's role and permissions, the state of the subscription and, while
   * the organization waits for its erasure, its deletion; the app shell loads it first.
   */
  @Get()
  @RequirePermission('workspace.read')
  @AllowWhenDeleted()
  @ZodResponse({ type: WorkspaceContextDto })
  async context(@Access() access: RequestAccess): Promise<WorkspaceContextDto> {
    const { userId, workspaceId } = workspaceOf(access);
    const [workspaces, entitlements] = await Promise.all([
      this.readModel.listWorkspaces({ userId, organizationId: access.organizationId }),
      this.entitlements.of(access.organizationId),
    ]);
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError();
    }
    return {
      workspace,
      organization: { id: access.organizationId, name: access.organizationName },
      role: access.role,
      permissions: permissionsOf(access.role),
      billing: toBillingStateDto(entitlements),
      deletion: toOrganizationDeletionDto(access.deletedAt),
    };
  }

  @Get('settings')
  @RequirePermission('workspace.read')
  @ZodResponse({ type: WorkspaceSettingsDto })
  async settings(@Access() access: RequestAccess): Promise<WorkspaceSettingsDto> {
    const { userId, organizationId, workspaceId } = workspaceOf(access);
    const settings = await this.readModel.workspaceSettings({ userId, organizationId, workspaceId });
    if (!settings) {
      throw new WorkspaceNotFoundError();
    }
    return settings;
  }

  @Patch('settings')
  @RequirePermission('settings.manage')
  @ZodResponse({ type: WorkspaceSettingsDto })
  updateSettings(
    @Access() access: RequestAccess,
    @Body() body: UpdateWorkspaceSettingsDto,
  ): Promise<WorkspaceSettingsDto> {
    const { userId, organizationId, workspaceId, role } = workspaceOf(access);
    return this.updateSettingsUseCase.execute({
      actor: { userId, organizationId, workspaceId, role },
      patch: body,
    });
  }
}
