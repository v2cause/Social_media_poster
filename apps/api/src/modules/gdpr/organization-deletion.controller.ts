import { Body, Controller, Delete, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CancelOrganizationErasure, RequestOrganizationErasure, type OrganizationActor } from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import {
  AllowWhenDeleted,
  AllowWhenReadOnly,
  OrgScope,
  RequirePermission,
} from '../../common/decorators/access.decorators';
import { AccessCache } from '../../common/guards/access-cache';
import { Actor } from '../../common/guards/request-access';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import { OrganizationDeletionDto, OrganizationDeletionRequestDto } from './gdpr.dto';

/**
 * The deletion of an organization by an owner (guide step 8.2, ADR 0037): with its name typed as
 * confirmation nobody works in it from then on, and the role "gdpr" erases it 30 days later. Until
 * then an owner takes the deletion back. The cached access of every member is dropped, so that
 * the guards see the new state at once.
 */
@ApiTags('organization-deletion')
@OrgScope()
// Deleting needs no paid plan, and neither does taking it back.
@AllowWhenReadOnly()
@Controller('org/:org/deletion')
export class OrganizationDeletionController {
  constructor(
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
    private readonly cache: AccessCache,
    private readonly requestErasure: RequestOrganizationErasure,
    private readonly cancelErasure: CancelOrganizationErasure,
  ) {}

  @Post()
  @RequirePermission('org.delete')
  @HttpCode(201)
  @ZodResponse({ status: 201, type: OrganizationDeletionDto })
  async create(
    @Actor() actor: OrganizationActor,
    @Body() body: OrganizationDeletionRequestDto,
  ): Promise<OrganizationDeletionDto> {
    // The members are read before the deletion; afterwards only its routes may be used.
    const members = await this.memberIds(actor);
    const erasure = await this.requestErasure.execute({ actor, confirmName: body.confirmName });
    await this.cache.invalidateUsers(members);
    return { deletedAt: erasure.createdAt.toISOString(), eraseAfter: erasure.runAfter.toISOString() };
  }

  /** Takes the deletion back while the erasure waits. */
  @Delete()
  @RequirePermission('org.delete')
  @AllowWhenDeleted()
  @HttpCode(204)
  async restore(@Actor() actor: OrganizationActor): Promise<void> {
    await this.cancelErasure.execute(actor);
    await this.cache.invalidateUsers(await this.memberIds(actor));
  }

  private async memberIds(actor: OrganizationActor): Promise<string[]> {
    const members = await this.readModel.listMembers({
      userId: actor.userId,
      organizationId: actor.organizationId,
    });
    return members.map((member) => member.userId);
  }
}
