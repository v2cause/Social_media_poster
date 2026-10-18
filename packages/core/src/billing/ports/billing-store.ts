import type { ReadOnlyReason, SubscriptionStatus } from '../domain/subscription';
import type { BillingState } from '../domain/sync';
import type { Subscription } from './subscription-store';

// The stores of billing besides the subscription reader (guide step 7.2): the customer of an
// organization, the inbox of the webhooks and the subscription as the role "billing" writes it.

/** The provider's customer of an organization, stored by the checkout. */
export interface BillingCustomers {
  /** Stores the customer unless the organization has one already; returns the one it keeps. */
  saveCustomer(organizationId: string, customerId: string): Promise<string>;
}

/** What billing keeps of a webhook: the ids it names, never the rest of the payload. */
export interface StoredWebhook {
  id: string;
  type: string;
  subscriptionId: string | null;
  customerId: string | null;
  processedAt: Date | null;
}

/** The inbox of the webhooks: every event once, processed once. */
export interface WebhookInbox {
  /** Records an event; true when it was processed already. */
  record(event: Omit<StoredWebhook, 'processedAt'>): Promise<{ processed: boolean }>;
  find(eventId: string): Promise<StoredWebhook | null>;
  markProcessed(eventId: string, at: Date): Promise<void>;
  /** Forgets an event that concerns no organization, for example after an erasure (guide step 8.2). */
  discard(eventId: string): Promise<void>;
}

/** The jobs of the role "billing". */
export interface BillingJobs {
  processWebhook(eventId: string): Promise<void>;
}

/** A subscription as the role "billing" reads and writes it, across organizations. */
export interface SubscriptionSync {
  byCustomer(customerId: string): Promise<Subscription | null>;
  save(organizationId: string, state: BillingState): Promise<void>;
}

/** Serializes the work on one customer, so two webhooks never write over each other. */
export interface BillingLock {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/** Tells the owners of an organization about its billing. */
export interface BillingNotifier {
  /**
   * A payment failed: the organization stays writable until the end of the grace period. Once
   * per event and owner, however often the event runs.
   */
  paymentFailed(notice: { eventId: string; organizationId: string; graceEndsAt: Date }): Promise<void>;
  /** The organization is read-only from this moment on. Once per organization and moment. */
  readOnly(notice: { organizationId: string; readOnlyAt: Date; reason: ReadOnlyReason }): Promise<void>;
}

/** The organizations that became read-only and whose owners have not heard of it yet. */
export interface ReadOnlyNotices {
  due(
    now: Date,
    limit: number,
  ): Promise<{ organizationId: string; status: SubscriptionStatus; readOnlyAt: Date }[]>;
  /** Marks the notice of this moment as sent; a later moment is announced again. */
  markSent(organizationId: string, readOnlyAt: Date, at: Date): Promise<void>;
}
