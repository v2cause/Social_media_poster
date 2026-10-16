import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { meSchema, toLocale, type Me } from '@smp/contracts';
import { createZodDto, ZodResponse } from 'nestjs-zod';

import { UserScope } from '../../common/decorators/access.decorators';
import type { AuthSession } from './auth';
import { CurrentUser } from './current-user.decorator';

export class MeDto extends createZodDto(meSchema) {}

@ApiTags('identity')
@UserScope()
@Controller('me')
export class MeController {
  /** The signed-in user. Organizations and workspaces follow with the tenancy API. */
  @Get()
  @ZodResponse({ type: MeDto })
  get(@CurrentUser() user: AuthSession['user']): Me {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled === true,
      locale: toLocale(user.locale),
      timezone: user.timezone,
    };
  }
}
