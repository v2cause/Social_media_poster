import {
  authorizationUrlSchema,
  channelOptionListSchema,
  confirmConnectionSchema,
  confirmedConnectionSchema,
  pendingConnectionSchema,
  socialAccountListSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of the channels API (guide step 4.5). The schemas live in
// @smp/contracts, where the accounts pages use them too.

export class ChannelOptionListDto extends createZodDto(channelOptionListSchema) {}
export class SocialAccountListDto extends createZodDto(socialAccountListSchema) {}
export class AuthorizationUrlDto extends createZodDto(authorizationUrlSchema) {}
export class PendingConnectionDto extends createZodDto(pendingConnectionSchema) {}
export class ConfirmConnectionDto extends createZodDto(confirmConnectionSchema) {}
export class ConfirmedConnectionDto extends createZodDto(confirmedConnectionSchema) {}
