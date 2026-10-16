import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DisconnectAccount, isPlatformError, missingScopesOf, StartConnection } from '@smp/core';
import type { ChannelReadModel } from '@smp/db';
import type { AdapterRegistry } from '@smp/platform-adapters';
import { ZodResponse } from 'nestjs-zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { actorOf, refOf } from '../content/content.mappers';
import { AuthorizationUrlDto, SocialAccountListDto } from './channels.dto';
import { ADAPTER_REGISTRY, CHANNEL_READ_MODEL } from './channels.providers';

const id = new ParseUUIDPipe();

/**
 * The connected accounts of a workspace (guide step 4.5): the list with the state of each
 * connection, reconnecting, and disconnecting, which revokes the grant at the platform once no
 * other account uses it.
 */
@ApiTags('accounts')
@WorkspaceScope()
@Controller('w/:ws/accounts')
export class AccountsController {
  private readonly logger = new Logger(AccountsController.name);

  constructor(
    @Inject(CHANNEL_READ_MODEL) private readonly readModel: ChannelReadModel,
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    private readonly startConnection: StartConnection,
    private readonly disconnectAccount: DisconnectAccount,
  ) {}

  @Get()
  @RequirePermission('workspace.read')
  @ZodResponse({ type: SocialAccountListDto })
  async list(@Access() access: RequestAccess): Promise<SocialAccountListDto> {
    const accounts = await this.readModel.accounts(refOf(actorOf(access)));
    return {
      items: accounts.map((account) => ({
        id: account.id,
        connectionId: account.connectionId,
        platform: account.platform,
        method: account.method,
        type: account.type,
        name: account.name,
        handle: account.handle,
        avatarUrl: account.avatarUrl,
        status: account.status,
        accessExpiresAt: account.accessExpiresAt?.toISOString() ?? null,
        missingScopes: missingScopesOf(
          this.registry.connector(account.platform, account.method)?.scopes ?? [],
          account.grantedScopes,
        ),
        connectedAt: account.connectedAt.toISOString(),
      })),
    };
  }

  @Post(':accountId/reconnect')
  @RequirePermission('account.manage')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: AuthorizationUrlDto })
  reconnect(
    @Access() access: RequestAccess,
    @Param('ws') workspaceSlug: string,
    @Param('accountId', id) accountId: string,
  ): Promise<AuthorizationUrlDto> {
    return this.startConnection.execute({
      actor: actorOf(access),
      workspaceSlug,
      reconnectAccountId: accountId,
    });
  }

  @Delete(':accountId')
  @RequirePermission('account.manage')
  @HttpCode(204)
  async disconnect(
    @Access() access: RequestAccess,
    @Param('accountId', id) accountId: string,
  ): Promise<void> {
    const result = await this.disconnectAccount.execute({ actor: actorOf(access), accountId });
    if (result.platformRevoke === 'failed') {
      // The account is disconnected and its tokens are gone; only the platform did not confirm.
      this.logger.warn(
        { accountId, code: isPlatformError(result.cause) ? result.cause.code : 'UNEXPECTED' },
        'channel.revoke.failed',
      );
    }
  }
}
