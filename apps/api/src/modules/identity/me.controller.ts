import { Controller, Get } from '@nestjs/common';
import { meSchema, toLocale, type Me } from '@smp/contracts';
import { createZodDto, ZodSerializerDto } from 'nestjs-zod';

import type { AuthSession } from './auth';
import { CurrentUser } from './current-user.decorator';

class MeDto extends createZodDto(meSchema) {}

@Controller('me')
export class MeController {
  /** The signed-in user. Organizations and workspaces follow with the tenancy API. */
  @Get()
  @ZodSerializerDto(MeDto)
  me(@CurrentUser() user: AuthSession['user']): Me {
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
