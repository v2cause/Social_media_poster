import { Body, Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { toLocale } from '@smp/contracts';
import { DisableXBrowser, EnableXBrowser, GetXBrowserStatus, type XBrowserStatus } from '@smp/core';
import type { Request } from 'express';
import { ZodResponse } from 'nestjs-zod';

import { RequestOriginService } from '../../common/cls/tenant-context';
import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { actorOf } from '../content/content.mappers';
import { PasswordCheck } from '../identity/password-check';
import { EnableXBrowserDto, XBrowserStatusDto } from './x-browser.dto';

const toStatusDto = (status: XBrowserStatus): XBrowserStatusDto => ({
  available: status.available,
  blocks: status.blocks,
  enabled: status.enabled,
  currentVersion: status.currentVersion,
  acknowledgement: status.acknowledgement
    ? {
        version: status.acknowledgement.textVersion,
        locale: toLocale(status.acknowledgement.locale),
        acceptedAt: status.acknowledgement.acceptedAt.toISOString(),
        acceptedBy:
          status.acknowledgement.userName === null
            ? null
            : { id: status.acknowledgement.userId, name: status.acknowledgement.userName },
      }
    : null,
});

/**
 * The X browser of a workspace (guide step 6.1): the status for everyone in the workspace, and
 * switching it on and off for owners and admins. Switching on asks for the password again and
 * stores the acknowledgement of the risk text with the IP address of the request.
 */
@ApiTags('x-browser')
@WorkspaceScope()
@Controller('w/:ws/x-browser')
export class XBrowserController {
  constructor(
    private readonly getStatus: GetXBrowserStatus,
    private readonly enableXBrowser: EnableXBrowser,
    private readonly disableXBrowser: DisableXBrowser,
    private readonly passwords: PasswordCheck,
    private readonly origin: RequestOriginService,
  ) {}

  @Get()
  @RequirePermission('workspace.read')
  @ZodResponse({ type: XBrowserStatusDto })
  async status(@Access() access: RequestAccess): Promise<XBrowserStatusDto> {
    return toStatusDto(await this.getStatus.execute(actorOf(access)));
  }

  @Post('activation')
  @RequirePermission('x_browser.enable')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: XBrowserStatusDto })
  async enable(
    @Access() access: RequestAccess,
    @Body() body: EnableXBrowserDto,
    @Req() request: Request,
  ): Promise<XBrowserStatusDto> {
    const actor = actorOf(access);
    await this.passwords.verify(request, actor.userId, body.password);
    const status = await this.enableXBrowser.execute({
      actor,
      version: body.version,
      locale: body.locale,
      ipAddress: this.origin.get().ipAddress ?? null,
    });
    return toStatusDto(status);
  }

  @Delete('activation')
  @RequirePermission('x_browser.enable')
  @ZodResponse({ type: XBrowserStatusDto })
  async disable(@Access() access: RequestAccess): Promise<XBrowserStatusDto> {
    return toStatusDto(await this.disableXBrowser.execute(actorOf(access)));
  }
}
