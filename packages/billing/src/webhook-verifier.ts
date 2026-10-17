import {
  WebhookSignatureInvalidError,
  type BillingWebhookEvent,
  type BillingWebhookVerifier,
} from '@smp/core';
import type Stripe from 'stripe';

// Checks the signature of a webhook of Stripe against the raw body, as the SDK does, and keeps
// only the ids billing needs (guide step 7.2). Customer data in the payload, such as addresses,
// is never passed on.

const idOf = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    return value.id;
  }
  return null;
};

/** The subscription and customer an event is about, by the kind of its object. */
function idsOf(event: Stripe.Event): { subscriptionId: string | null; customerId: string | null } {
  const object = event.data.object as unknown as Record<string, unknown>;
  const customerId = idOf(object['customer']);
  switch (object['object']) {
    case 'subscription':
      return { subscriptionId: idOf(object['id']), customerId };
    case 'checkout.session':
      return { subscriptionId: idOf(object['subscription']), customerId };
    case 'invoice': {
      const parent = object['parent'] as { subscription_details?: { subscription?: unknown } } | null;
      return { subscriptionId: idOf(parent?.subscription_details?.subscription), customerId };
    }
    default:
      return { subscriptionId: null, customerId };
  }
}

export class StripeWebhookVerifier implements BillingWebhookVerifier {
  constructor(
    private readonly stripe: Stripe,
    private readonly secret: string,
  ) {}

  verify(rawBody: Uint8Array, signature: string): BillingWebhookEvent {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(Buffer.from(rawBody), signature, this.secret);
    } catch {
      throw new WebhookSignatureInvalidError();
    }
    return { id: event.id, type: event.type, createdAt: new Date(event.created * 1000), ...idsOf(event) };
  }
}
