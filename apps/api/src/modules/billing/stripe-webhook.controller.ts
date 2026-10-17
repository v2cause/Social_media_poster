import { Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  BillingUnavailableError,
  RecordStripeWebhook,
  WebhookSignatureInvalidError,
  type BillingWebhookVerifier,
} from '@smp/core';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { STRIPE_VERIFIER } from './billing.providers';

/**
 * The webhooks of Stripe (guide step 7.2): the signature is checked against the raw body, which
 * bootstrap.ts keeps for /api/webhooks, then the event is recorded once and queued for the role
 * "billing". The answer comes before the processing, so Stripe does not wait for it.
 */
@ApiExcludeController()
@Public()
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(
    @Inject(STRIPE_VERIFIER) private readonly verifier: BillingWebhookVerifier | null,
    private readonly record: RecordStripeWebhook,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: Request,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!this.verifier) {
      throw new BillingUnavailableError();
    }
    const body: unknown = request.body;
    if (!Buffer.isBuffer(body) || !signature) {
      throw new WebhookSignatureInvalidError();
    }
    await this.record.execute(this.verifier.verify(body, signature));
    return { received: true };
  }
}
