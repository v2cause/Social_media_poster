import type { VariantStatus } from '../../content/domain/types';

// Events of the transactional outbox (architecture 7): a use case writes them in the transaction
// of its change, and tick.outbox-relay turns each one into a job or a live event after the commit.
// Payloads hold ids only; the job reads everything else from the database.

export interface OutboxEventPayloads {
  /**
   * The publish job of a schedule version, without waiting for the tick: "Jetzt posten" (now),
   * another attempt after a failure (retry), or another reconcile of an unclear one (recheck).
   */
  'publish.requested': { variantId: string; scheduleVersion: number; trigger: 'now' | 'retry' | 'recheck' };
  /** A variant changed its status; the relay passes it on to the live events (step 4.10). */
  'variant.status': { variantId: string; postId: string; status: VariantStatus; scheduleVersion: number };
}

export type OutboxEventType = keyof OutboxEventPayloads;

export const OUTBOX_EVENT_TYPES = [
  'publish.requested',
  'variant.status',
] as const satisfies readonly OutboxEventType[];

export interface OutboxEventInput<T extends OutboxEventType = OutboxEventType> {
  type: T;
  payload: OutboxEventPayloads[T];
}
