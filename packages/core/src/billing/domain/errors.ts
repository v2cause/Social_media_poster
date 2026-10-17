import { DomainError } from '../../shared/domain/errors';
import type { CountedLimit } from './plan';

/** One more would go beyond a limit of the plan (HTTP 402). Existing resources stay. */
export class PlanLimitReachedError extends DomainError {
  readonly code = 'PLAN_LIMIT_REACHED';
  readonly kind = 'quota_exceeded';
  override readonly params: { limit: CountedLimit; max: number };

  constructor(limit: CountedLimit, max: number) {
    super(`The plan allows ${String(max)} for ${limit}.`);
    this.params = { limit, max };
  }
}

/** The organization is read-only: its trial ended, a payment is overdue past the grace period or
 * its subscription ended (HTTP 402). */
export class SubscriptionInactiveError extends DomainError {
  readonly code = 'SUBSCRIPTION_INACTIVE';
  readonly kind = 'quota_exceeded';
  constructor() {
    super('The subscription of the organization is not active; it is read-only.');
  }
}

/** A paid subscription exists already; plans change in the customer portal (HTTP 409). */
export class SubscriptionExistsError extends DomainError {
  readonly code = 'SUBSCRIPTION_EXISTS';
  readonly kind = 'conflict';
  constructor() {
    super('The organization has a subscription already.');
  }
}

/** Stripe is not set up in this deployment (HTTP 503). */
export class BillingUnavailableError extends DomainError {
  readonly code = 'BILLING_UNAVAILABLE';
  readonly kind = 'unavailable';
  constructor() {
    super('Billing is not set up in this deployment.');
  }
}

/** The customer portal needs a Stripe customer, which the first checkout creates (HTTP 409). */
export class BillingCustomerMissingError extends DomainError {
  readonly code = 'BILLING_CUSTOMER_MISSING';
  readonly kind = 'conflict';
  constructor() {
    super('The organization is not a customer of Stripe yet.');
  }
}

/** A webhook without a valid signature of the provider (HTTP 422); nothing of it is used. */
export class WebhookSignatureInvalidError extends DomainError {
  readonly code = 'WEBHOOK_SIGNATURE_INVALID';
  readonly kind = 'invalid';
  constructor() {
    super('The signature of the webhook is invalid.');
  }
}
