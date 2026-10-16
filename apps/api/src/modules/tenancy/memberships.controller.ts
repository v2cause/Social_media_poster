import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import type { CreateOrganizationResult } from '@smp/core';
import { CreateOrganization } from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import { ZodSerializerDto } from 'nestjs-zod';

import { UserScope } from '../../common/decorators/access.decorators';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import type { AuthSession } from '../identity/auth';
import { CurrentUser } from '../identity/current-user.decorator';
import { CreateOrganizationDto, CreateOrganizationResponseDto, MyMembershipsDto } from './tenancy.dto';

/** Routes of the signed-in user that belong to no organization yet. */
@UserScope()
@Controller()
export class MembershipsController {
  constructor(
    private readonly createOrganization: CreateOrganization,
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
  ) {}

  /** The user's organizations and the workspaces the user may open: the workspace switcher. */
  @Get('me/memberships')
  @ZodSerializerDto(MyMembershipsDto)
  async memberships(@CurrentUser() user: AuthSession['user']): Promise<MyMembershipsDto> {
    return { memberships: await this.readModel.membershipsOfUser(user.id) };
  }

  /** Onboarding: organization, first workspace and owner membership in one step. */
  @Post('organizations')
  @ZodSerializerDto(CreateOrganizationResponseDto)
  create(
    @CurrentUser() user: AuthSession['user'],
    @Body() body: CreateOrganizationDto,
  ): Promise<CreateOrganizationResult> {
    return this.createOrganization.execute({
      user: { id: user.id, emailVerified: user.emailVerified },
      name: body.name,
      workspace: body.workspace,
    });
  }
}
