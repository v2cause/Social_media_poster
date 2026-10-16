// Events of the transactional outbox (architecture 7): a use case writes them in the transaction
// of its change, and tick.outbox-relay turns each one into a job or a live event after the commit.
// Payloads hold ids only; the job reads everything else from the database.

export interface OutboxEventPayloads {
  /** "Jetzt posten" or a retry: the publish job of a schedule version, without waiting for the tick. */
  'publish.requested': { variantId: string; scheduleVersion: number; trigger: 'now' | 'retry' };
}

export type OutboxEventType = keyof OutboxEventPayloads;

export const OUTBOX_EVENT_TYPES = ['publish.requested'] as const satisfies readonly OutboxEventType[];

export interface OutboxEventInput<T extends OutboxEventType = OutboxEventType> {
  type: T;
  payload: OutboxEventPayloads[T];
}
