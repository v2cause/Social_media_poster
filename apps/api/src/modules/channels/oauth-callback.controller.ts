import { Controller, Get, Inject, Logger, Param, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { hours } from '@nestjs/throttler';
import { CompleteAuthorization, isPlatformError, type AuthorizationOutcome } from '@smp/core';
import { platformOfSlug, platformSlugSchema } from '@smp/contracts';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';
import { clipped, logSecurityEvent } from '../../common/logging/security-events';
import { LimitPerUser } from '../../common/throttling/throttling';
import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { AUTH, type Auth } from '../identity/auth';

// The global OAuth callback (guide step 4.5): one fixed redirect URI per platform, as the platform
// apps register it. The browser arrives here from the platform, so every outcome is a redirect
// into the web app: to the selection of the accounts, or back to the accounts page with the
// reason in connect_error. Public, because a missing session also ends in a redirect (to the
// sign-in) instead of an error document; the use case then checks the user against the state.

const callbackQuerySchema = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(200).optional(),
});

@Public()
@ApiExcludeController()
@Controller('oauth')
export class OAuthCallbackController {
  private readonly logger = new Logger(OAuthCallbackController.name);

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(API_ENV) private readonly env: Pick<ApiEnv, 'APP_URL'>,
    private readonly completeAuthorization: CompleteAuthorization,
  ) {}

  @LimitPerUser(60, hours(1))
  @Get(':platform/callback')
  async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Param('platform') slug: string,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) {
      response.redirect(this.appUrl('/login'));
      return;
    }
    const platform = platformSlugSchema.safeParse(slug);
    const params = callbackQuerySchema.safeParse(query);
    if (!platform.success || !params.success) {
      logSecurityEvent('security.oauth_rejected', request, {
        platform: clipped(slug),
        reason: 'STATE_INVALID',
      });
      response.redirect(this.failureUrl({ status: 'failed', reason: 'STATE_INVALID', workspaceSlug: null }));
      return;
    }

    const outcome = await this.completeAuthorization.execute({
      userId: session.user.id,
      platform: platformOfSlug(platform.data),
      state: params.data.state,
      code: params.data.code ?? null,
      error: params.data.error ?? null,
    });
    if (outcome.status === 'pending') {
      response.redirect(
        this.appUrl(`/w/${encodeURIComponent(outcome.workspaceSlug)}/accounts/connect/select`, {
          pending: outcome.pendingId,
        }),
      );
      return;
    }
    if (outcome.reason === 'STATE_INVALID') {
      // Unknown, used, expired, or of another user: a forged or replayed callback looks like this.
      logSecurityEvent('security.oauth_rejected', request, {
        platform: platform.data,
        reason: outcome.reason,
      });
    }
    if (outcome.reason === 'EXCHANGE_FAILED') {
      const { cause } = outcome;
      this.logger.warn(
        {
          platform: platform.data,
          code: isPlatformError(cause) ? cause.code : 'UNEXPECTED',
          status: isPlatformError(cause) ? cause.status : undefined,
        },
        'oauth.exchange.failed',
      );
    }
    response.redirect(this.failureUrl(outcome));
  }

  /** Back to the accounts of the workspace, or to the start page when the workspace is unknown. */
  private failureUrl(outcome: Extract<AuthorizationOutcome, { status: 'failed' }>): string {
    const path = outcome.workspaceSlug ? `/w/${encodeURIComponent(outcome.workspaceSlug)}/accounts` : '/';
    return this.appUrl(path, { connect_error: outcome.reason });
  }

  private appUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, this.env.APP_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}
