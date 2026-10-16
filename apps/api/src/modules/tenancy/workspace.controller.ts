import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { permissionsOf } from '@smp/contracts';
import { UpdateWorkspaceSettings, WorkspaceNotFoundError } from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import { ZodSerializerDto } from 'nestjs-zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import { UpdateWorkspaceSettingsDto, WorkspaceContextDto, WorkspaceSettingsDto } from './tenancy.dto';

type WorkspaceAccess = RequestAccess & { workspaceId: string };

function workspaceOf(access: RequestAccess): WorkspaceAccess {
  if (!access.workspaceId) {
    throw new WorkspaceNotFoundError();
  }
  return { ...access, workspaceId: access.workspaceId };
}

/** The workspace of /api/w/:ws and its settings. */
@WorkspaceScope()
@Controller('w/:ws')
export class WorkspaceController {
  constructor(
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
    private readonly updateSettings: UpdateWorkspaceSettings,
  ) {}

  /** The workspace with the caller's role and permissions; the app shell loads it first. */
  @Get()
  @RequirePermission('workspace.read')
  @ZodSerializerDto(WorkspaceContextDto)
  async context(@Access() access: RequestAccess): Promise<WorkspaceContextDto> {
    const { userId, workspaceId } = workspaceOf(access);
    const workspaces = await this.readModel.listWorkspaces({ userId, organizationId: access.organizationId });
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError();
    }
    return {
      workspace,
      organization: { id: access.organizationId, name: access.organizationName },
      role: access.role,
      permissions: permissionsOf(access.role),
    };
  }

  @Get('settings')
  @RequirePermission('workspace.read')
  @ZodSerializerDto(WorkspaceSettingsDto)
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
  @ZodSerializerDto(WorkspaceSettingsDto)
  update(
    @Access() access: RequestAccess,
    @Body() body: UpdateWorkspaceSettingsDto,
  ): Promise<WorkspaceSettingsDto> {
    const { userId, organizationId, workspaceId, role } = workspaceOf(access);
    return this.updateSettings.execute({ actor: { userId, organizationId, workspaceId, role }, patch: body });
  }
}
