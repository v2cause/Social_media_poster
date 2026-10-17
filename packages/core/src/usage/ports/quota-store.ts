import type { UsageMeter } from '../domain/meters';

/** The counter of one organization, meter and period. */
export interface QuotaKey {
  organizationId: string;
  meter: UsageMeter;
  /** The first day of the period, UTC midnight. */
  periodStart: Date;
}

/** The actual usage of one source, for example one AiGeneration. */
export interface UsageSettlement {
  /** The workspace the usage belongs to, if any. */
  workspaceId: string | null;
  /** What the reservation added to the counter. */
  reserved: bigint;
  /** The actual quantity. */
  quantity: bigint;
  sourceType: string;
  sourceId: string;
}

/** Counters and ledger of the quotas (guide step 2.6). Implemented in @smp/db. */
export interface QuotaStore {
  /**
   * Adds amount to the counter if the sum stays within limit, atomically even under concurrent
   * reservations. Returns the new value, or null when the limit would be exceeded; the counter
   * then stays unchanged.
   */
  reserve(key: QuotaKey, amount: bigint, limit: bigint): Promise<bigint | null>;
  /**
   * Books the actual quantity once per source and meter: writes the ledger entry and moves the
   * counter by quantity minus reserved, never below zero. Returns false when the source was booked
   * before; nothing changes then.
   */
  settle(key: QuotaKey, settlement: UsageSettlement): Promise<boolean>;
  /** The counter value; 0 for a period without reservations. */
  current(key: QuotaKey): Promise<bigint>;
}

/** The limit of a meter per period: the credits and the overage of the plan (guide step 7.4). */
export interface QuotaLimits {
  limitOf(organizationId: string, meter: UsageMeter): Promise<bigint>;
}
