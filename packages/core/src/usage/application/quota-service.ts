import type { Clock } from '../../shared/ports/clock';
import { QuotaExceededError } from '../domain/errors';
import { monthlyPeriodStart, type UsageMeter } from '../domain/meters';
import type { QuotaKey, QuotaLimits, QuotaStore } from '../ports/quota-store';

// Quotas with reservation and settlement (guide step 2.6, architecture 5.3). Before a metered
// call, the estimate is reserved atomically against the limit of the period; afterwards
// finalize books the actual quantity: the ledger gets one entry per source and the counter the
// difference to the estimate. Callers finalize in a finally block, also after errors and aborts.

export interface QuotaDependencies {
  store: QuotaStore;
  limits: QuotaLimits;
  clock: Clock;
}

export interface QuotaScope {
  organizationId: string;
  workspaceId: string | null;
}

/** The actual usage of the call a reservation was made for. */
export interface UsageBooking {
  quantity: bigint;
  /** For example "ai_generation" with the id of the AiGeneration. */
  sourceType: string;
  sourceId: string;
}

export class QuotaReservation {
  private finalized = false;

  constructor(
    private readonly store: QuotaStore,
    private readonly key: QuotaKey,
    private readonly workspaceId: string | null,
    /** What the reservation added to the counter. */
    readonly reserved: bigint,
  ) {}

  get periodStart(): Date {
    return this.key.periodStart;
  }

  /**
   * Books the actual usage in the period of the reservation. Safe to call more than once: only
   * the first call per source counts, in this process and in the ledger.
   */
  async finalize(booking: UsageBooking): Promise<void> {
    if (booking.quantity < 0n) {
      throw new RangeError('A booked quantity cannot be negative.');
    }
    if (this.finalized) {
      return;
    }
    await this.store.settle(this.key, {
      workspaceId: this.workspaceId,
      reserved: this.reserved,
      quantity: booking.quantity,
      sourceType: booking.sourceType,
      sourceId: booking.sourceId,
    });
    this.finalized = true;
  }
}

export interface QuotaUsage {
  used: bigint;
  limit: bigint;
  periodStart: Date;
}

export class QuotaService {
  constructor(private readonly deps: QuotaDependencies) {}

  /** Reserves amount in the current period; throws QuotaExceededError when it does not fit. */
  async reserve(scope: QuotaScope, meter: UsageMeter, amount: bigint): Promise<QuotaReservation> {
    if (amount < 0n) {
      throw new RangeError('A reserved amount cannot be negative.');
    }
    const key = this.keyOf(scope.organizationId, meter);
    const limit = await this.deps.limits.limitOf(scope.organizationId, meter);
    const value = await this.deps.store.reserve(key, amount, limit);
    if (value === null) {
      throw new QuotaExceededError(meter);
    }
    return new QuotaReservation(this.deps.store, key, scope.workspaceId, amount);
  }

  /** The usage of the current period, for the UI. */
  async usage(organizationId: string, meter: UsageMeter): Promise<QuotaUsage> {
    const key = this.keyOf(organizationId, meter);
    const [used, limit] = await Promise.all([
      this.deps.store.current(key),
      this.deps.limits.limitOf(organizationId, meter),
    ]);
    return { used, limit, periodStart: key.periodStart };
  }

  private keyOf(organizationId: string, meter: UsageMeter): QuotaKey {
    return { organizationId, meter, periodStart: monthlyPeriodStart(this.deps.clock.now()) };
  }
}

/** The same limit for every organization: for tests; the API takes it from the plan (guide step 7.4). */
export const fixedQuotaLimits = (limits: Readonly<Record<UsageMeter, bigint>>): QuotaLimits => ({
  limitOf: (_organizationId, meter) => Promise.resolve(limits[meter]),
});
