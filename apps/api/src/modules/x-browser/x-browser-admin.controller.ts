import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  GetXBrowserAdmin,
  SetXBrowserKillSwitch,
  SetXBrowserOrganization,
  type XBrowserAdminView,
} from '@smp/core';
import { ZodResponse } from 'nestjs-zod';

import { UserScope } from '../../common/decorators/access.decorators';
import type { AuthSession } from '../identity/auth';
import { CurrentUser } from '../identity/current-user.decorator';
import { PlatformAdminGuard } from '../identity/platform-admin.guard';
import {
  AllowXBrowserOrganizationDto,
  SetKillSwitchDto,
  XBrowserAdminDto,
  XBrowserOrganizationDto,
} from './x-browser.dto';

const toAdminDto = (view: XBrowserAdminView): XBrowserAdminDto => ({
  offered: view.offered,
  killSwitch: { active: view.killSwitch.active, updatedAt: view.killSwitch.updatedAt?.toISOString() ?? null },
  organizations: view.organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    updatedAt: organization.updatedAt.toISOString(),
  })),
});

/**
 * The switches of the platform admins (guide step 6.1): the global kill switch of the X browser
 * and, until the plans of phase 7, the organizations allowed to use it. Every change is logged
 * with the admin; the flags themselves belong to no organization and so to no audit log.
 */
@ApiTags('admin')
@UserScope()
@UseGuards(PlatformAdminGuard)
@Controller('admin/x-browser')
export class XBrowserAdminController {
  private readonly logger = new Logger(XBrowserAdminController.name);

  constructor(
    private readonly getAdmin: GetXBrowserAdmin,
    private readonly killSwitch: SetXBrowserKillSwitch,
    private readonly organizations: SetXBrowserOrganization,
  ) {}

  @Get()
  @ZodResponse({ type: XBrowserAdminDto })
  async get(): Promise<XBrowserAdminDto> {
    return toAdminDto(await this.getAdmin.execute());
  }

  @Put('kill-switch')
  @ZodResponse({ type: XBrowserAdminDto })
  async setKillSwitch(
    @Body() body: SetKillSwitchDto,
    @CurrentUser() user: AuthSession['user'],
  ): Promise<XBrowserAdminDto> {
    const changed = await this.killSwitch.execute(body.active);
    this.logger.warn({ adminId: user.id, active: body.active, changed }, 'x_browser.kill_switch');
    return toAdminDto(await this.getAdmin.execute());
  }

  @Post('organizations')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: XBrowserOrganizationDto })
  async allow(
    @Body() body: AllowXBrowserOrganizationDto,
    @CurrentUser() user: AuthSession['user'],
  ): Promise<XBrowserOrganizationDto> {
    const organization = await this.organizations.allow(body.workspaceSlug);
    this.logger.warn({ adminId: user.id, organizationId: organization.id }, 'x_browser.organization_allowed');
    return { id: organization.id, name: organization.name };
  }

  @Delete('organizations/:organizationId')
  @HttpCode(204)
  async disallow(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @CurrentUser() user: AuthSession['user'],
  ): Promise<void> {
    await this.organizations.disallow(organizationId);
    this.logger.warn({ adminId: user.id, organizationId }, 'x_browser.organization_disallowed');
  }
}
