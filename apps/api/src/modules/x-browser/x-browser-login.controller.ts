import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { hours } from '@nestjs/throttler';
import {
  BrowserLoginNotFoundError,
  GetBrowserLogin,
  StartBrowserLogin,
  SubmitBrowserLoginCode,
  type BrowserLogin,
} from '@smp/core';
import { ZodResponse } from 'nestjs-zod';
import { z } from 'zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { LimitPerUser } from '../../common/throttling/throttling';
import { actorOf } from '../content/content.mappers';
import { StartXbLoginDto, XbLoginCodeDto, XbLoginSessionDto } from './x-browser.dto';

const toLoginDto = (login: BrowserLogin): XbLoginSessionDto => ({
  id: login.id,
  status: login.status,
  failure: login.failure,
  accountId: login.accountId,
  expiresAt: login.expiresAt.toISOString(),
});

/** A login id in its own shape; anything else cannot exist. */
const loginIdOf = (value: string): string => {
  if (!z.uuid().safeParse(value).success) {
    throw new BrowserLoginNotFoundError();
  }
  return value;
};

/**
 * The interactive login of X without the API (guide step 6.4): the start with user name and
 * password, its status, and the code of the two-factor login. The credentials and the codes go
 * on sealed for the browser worker and are neither stored nor logged; the steps also reach the
 * browser of the user as the live event xb.login.
 */
@ApiTags('x-browser')
@WorkspaceScope()
@Controller('w/:ws/x-browser/login-sessions')
export class XBrowserLoginController {
  constructor(
    private readonly startLogin: StartBrowserLogin,
    private readonly getLogin: GetBrowserLogin,
    private readonly submitCode: SubmitBrowserLoginCode,
  ) {}

  @LimitPerUser(10, hours(1))
  @Post()
  @RequirePermission('account.manage')
  @ZodResponse({ status: 201, type: XbLoginSessionDto })
  async start(@Access() access: RequestAccess, @Body() body: StartXbLoginDto): Promise<XbLoginSessionDto> {
    const login = await this.startLogin.execute({
      actor: actorOf(access),
      username: body.username,
      password: body.password,
      locale: body.locale,
      reconnectAccountId: body.reconnectAccountId ?? null,
    });
    return toLoginDto(login);
  }

  @Get(':loginId')
  @RequirePermission('account.manage')
  @ZodResponse({ type: XbLoginSessionDto })
  async get(@Access() access: RequestAccess, @Param('loginId') loginId: string): Promise<XbLoginSessionDto> {
    return toLoginDto(await this.getLogin.execute(actorOf(access), loginIdOf(loginId)));
  }

  @LimitPerUser(20, hours(1))
  @Post(':loginId/code')
  @RequirePermission('account.manage')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: XbLoginSessionDto })
  async code(
    @Access() access: RequestAccess,
    @Param('loginId') loginId: string,
    @Body() body: XbLoginCodeDto,
  ): Promise<XbLoginSessionDto> {
    const login = await this.submitCode.execute({
      actor: actorOf(access),
      loginId: loginIdOf(loginId),
      code: body.code,
    });
    return toLoginDto(login);
  }
}
