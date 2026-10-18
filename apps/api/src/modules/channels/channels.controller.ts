import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { hours } from '@nestjs/throttler';
import {
  ConfirmConnection,
  GetPendingConnection,
  PendingConnectionNotFoundError,
  StartConnection,
} from '@smp/core';
import { pendingConnectionIdSchema, platformOfSlug, platformSlugSchema } from '@smp/contracts';
import type { AdapterRegistry } from '@smp/platform-adapters';
import type { Platform } from '@smp/platform-rules';
import { ZodResponse } from 'nestjs-zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { LimitPerUser } from '../../common/throttling/throttling';
import { actorOf } from '../content/content.mappers';
import {
  AuthorizationUrlDto,
  ChannelOptionListDto,
  ConfirmConnectionDto,
  ConfirmedConnectionDto,
  PendingConnectionDto,
} from './channels.dto';
import { ADAPTER_REGISTRY } from './channels.providers';

/** The platform of a path like /channels/linkedin/connect; 404 for anything else. */
const platformOf = (slug: string): Platform => {
  const parsed = platformSlugSchema.safeParse(slug);
  if (!parsed.success) {
    throw new NotFoundException();
  }
  return platformOfSlug(parsed.data);
};

/** A pending id in its own shape; anything else cannot exist. */
const pendingIdOf = (value: string): string => {
  if (!pendingConnectionIdSchema.safeParse(value).success) {
    throw new PendingConnectionNotFoundError();
  }
  return value;
};

/**
 * Connecting the platforms of a workspace (guide step 4.5): the platforms on offer, the start of
 * the OAuth flow, and the selection of the accounts after the consent. The callback in between
 * is global (OAuthCallbackController).
 */
@ApiTags('channels')
@WorkspaceScope()
@Controller('w/:ws/channels')
export class ChannelsController {
  constructor(
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly startConnection: StartConnection,
    private readonly getPending: GetPendingConnection,
    private readonly confirmConnection: ConfirmConnection,
  ) {}

  @Get()
  @RequirePermission('workspace.read')
  @ZodResponse({ type: ChannelOptionListDto })
  list(): ChannelOptionListDto {
    return { items: this.registry.methods() };
  }

  @LimitPerUser(30, hours(1))
  @Post(':platform/connect')
  @RequirePermission('account.manage')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: AuthorizationUrlDto })
  connect(
    @Access() access: RequestAccess,
    @Param('ws') workspaceSlug: string,
    @Param('platform') platform: string,
  ): Promise<AuthorizationUrlDto> {
    return this.startConnection.execute({
      actor: actorOf(access),
      workspaceSlug,
      platform: platformOf(platform),
    });
  }

  @Get('pending/:pendingId')
  @RequirePermission('account.manage')
  @ZodResponse({ type: PendingConnectionDto })
  async pending(
    @Access() access: RequestAccess,
    @Param('pendingId') pendingId: string,
  ): Promise<PendingConnectionDto> {
    const view = await this.getPending.execute({ actor: actorOf(access), pendingId: pendingIdOf(pendingId) });
    return { ...view, expiresAt: view.expiresAt.toISOString() };
  }

  @Post('pending/:pendingId/confirm')
  @RequirePermission('account.manage')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: ConfirmedConnectionDto })
  confirm(
    @Access() access: RequestAccess,
    @Param('pendingId') pendingId: string,
    @Body() body: ConfirmConnectionDto,
  ): Promise<ConfirmedConnectionDto> {
    return this.confirmConnection.execute({
      actor: actorOf(access),
      pendingId: pendingIdOf(pendingId),
      externalIds: body.externalIds,
    });
  }
}
