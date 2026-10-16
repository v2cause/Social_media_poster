import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { systemClock } from '@smp/core';
import { mockConsentLinks, usesMockPlatform } from '@smp/platform-adapters';
import { PLATFORMS } from '@smp/platform-rules';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';
import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { oauthCallbackUrl } from '../channels/oauth-urls';
import { pageLocaleOf, renderMockConsentPage } from './mock-oauth.page';

// The fake OAuth page of the mock platforms (guide step 4.4). AppModule registers it outside
// production only, and it answers only for platforms in mock mode. It sends back to the callback
// of this app and nowhere else, so it cannot serve as an open redirect.

const authorizeQuerySchema = z.object({
  platform: z.enum(PLATFORMS),
  state: z.string().regex(/^[\w-]{16,128}$/),
  redirect_uri: z.url(),
  scope: z
    .string()
    .max(2_000)
    .transform((value) => value.split(' ').filter(Boolean))
    .pipe(z.array(z.string().max(80)).min(1).max(20)),
  // RFC 7636: an S256 challenge is the base64url form of 32 bytes.
  code_challenge: z
    .string()
    .regex(/^[\w-]{43}$/)
    .optional(),
  code_challenge_method: z.literal('S256').optional(),
});

type MockOAuthEnv = Pick<
  ApiEnv,
  'NODE_ENV' | 'APP_URL' | 'PLATFORM_MODE_LINKEDIN' | 'PLATFORM_MODE_META' | 'PLATFORM_MODE_X'
>;

@Public()
@ApiExcludeController()
@Controller('dev/mock-oauth')
export class MockOAuthController {
  constructor(@Inject(API_ENV) private readonly env: MockOAuthEnv) {}

  @Get('authorize')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  authorize(
    @Query() query: Record<string, unknown>,
    @Headers('cookie') cookie?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): string {
    const parsed = authorizeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException('The authorization request is invalid.');
    }
    const request = parsed.data;
    if (!usesMockPlatform(this.env, request.platform)) {
      throw new NotFoundException();
    }
    if (request.redirect_uri !== oauthCallbackUrl(this.env.APP_URL, request.platform)) {
      throw new BadRequestException('The redirect URI is not the callback of this app.');
    }
    if ((request.code_challenge === undefined) !== (request.code_challenge_method === undefined)) {
      throw new BadRequestException('A code challenge needs the method S256.');
    }

    const links = mockConsentLinks({
      platform: request.platform,
      state: request.state,
      redirectUri: request.redirect_uri,
      scopes: request.scope,
      codeChallenge: request.code_challenge ?? null,
      now: systemClock.now().getTime(),
    });
    return renderMockConsentPage({
      platform: request.platform,
      scopes: request.scope,
      links,
      locale: pageLocaleOf({ cookie, acceptLanguage }),
    });
  }
}
