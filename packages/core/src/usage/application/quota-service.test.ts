import { describe, expect, it } from 'vitest';

import type { Clock } from '../../shared/ports/clock';
import { QuotaExceededError } from '../domain/errors';
import { monthlyPeriodStart } from '../domain/meters';
import type { QuotaKey, QuotaStore, UsageSettlement } from '../ports/quota-store';
import { fixedQuotaLimits, QuotaService } from './quota-service';

// The rules of the quota service with an in-memory store; the atomic SQL of the store is tested
// against PostgreSQL in @smp/db.

class MemoryQuotaStore implements QuotaStore {
  readonly counters = new Map<string, bigint>();
  readonly ledger: (UsageSettlement & { key: QuotaKey })[] = [];

  private id = (key: QuotaKey): string =>
    `${key.organizationId}/${key.meter}/${key.periodStart.toISOString()}`;

  reserve(key: QuotaKey, amount: bigint, limit: bigint): Promise<bigint | null> {
    const value = (this.counters.get(this.id(key)) ?? 0n) + amount;
    if (value > limit) {
      return Promise.resolve(null);
    }
    this.counters.set(this.id(key), value);
    return Promise.resolve(value);
  }

  settle(key: QuotaKey, settlement: UsageSettlement): Promise<boolean> {
    // Unique per source and meter, like the ledger table; there is only one meter so far.
    if (
      this.ledger.some(
        (entry) => entry.sourceType === settlement.sourceType && entry.sourceId === settlement.sourceId,
      )
    ) {
      return Promise.resolve(false);
    }
    this.ledger.push({ ...settlement, key });
    const value = (this.counters.get(this.id(key)) ?? 0n) + settlement.quantity - settlement.reserved;
    this.counters.set(this.id(key), value < 0n ? 0n : value);
    return Promise.resolve(true);
  }

  current(key: QuotaKey): Promise<bigint> {
    return Promise.resolve(this.counters.get(this.id(key)) ?? 0n);
  }
}

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });

const setup = (iso = '2026-10-16T12:00:00Z', limit = 1_000n) => {
  const store = new MemoryQuotaStore();
  const service = new QuotaService({
    store,
    limits: fixedQuotaLimits({ ai_micros: limit }),
    clock: clockAt(iso),
  });
  return { store, service };
};

const scope = { organizationId: 'org-1', workspaceId: 'ws-1' };

describe('monthlyPeriodStart', () => {
  it('is the first day of the month in UTC, whatever the local time zone', () => {
    expect(monthlyPeriodStart(new Date('2026-10-31T23:59:59.999Z'))).toEqual(
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(monthlyPeriodStart(new Date('2026-11-01T00:00:00Z'))).toEqual(new Date('2026-11-01T00:00:00Z'));
    // 00:30 in Berlin on 1 November is still October in UTC.
    expect(monthlyPeriodStart(new Date('2026-11-01T00:30:00+01:00'))).toEqual(
      new Date('2026-10-01T00:00:00Z'),
    );
  });
});

describe('QuotaService', () => {
  it('reserves within the limit and refuses what does not fit', async () => {
    const { service } = setup();

    await service.reserve(scope, 'ai_micros', 600n);
    await service.reserve(scope, 'ai_micros', 400n);

    await expect(service.reserve(scope, 'ai_micros', 1n)).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(service.reserve(scope, 'ai_micros', 1n)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      kind: 'quota_exceeded',
      meter: 'ai_micros',
    });
    expect(await service.usage(scope.organizationId, 'ai_micros')).toEqual({
      used: 1_000n,
      limit: 1_000n,
      periodStart: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('books the actual quantity once and corrects the counter by the difference', async () => {
    const { service, store } = setup();
    const reservation = await service.reserve(scope, 'ai_micros', 500n);
    const booking = { quantity: 120n, sourceType: 'ai_generation', sourceId: 'gen-1' };

    await reservation.finalize(booking);
    await reservation.finalize(booking);

    expect(await service.usage(scope.organizationId, 'ai_micros')).toMatchObject({ used: 120n });
    expect(store.ledger).toEqual([
      {
        key: { organizationId: 'org-1', meter: 'ai_micros', periodStart: new Date('2026-10-01T00:00:00Z') },
        workspaceId: 'ws-1',
        reserved: 500n,
        quantity: 120n,
        sourceType: 'ai_generation',
        sourceId: 'gen-1',
      },
    ]);
  });

  it('also books a quantity above the estimate, and a canceled call at zero', async () => {
    const { service } = setup();
    const expensive = await service.reserve(scope, 'ai_micros', 100n);
    const canceled = await service.reserve(scope, 'ai_micros', 300n);

    await expensive.finalize({ quantity: 250n, sourceType: 'ai_generation', sourceId: 'gen-1' });
    await canceled.finalize({ quantity: 0n, sourceType: 'ai_generation', sourceId: 'gen-2' });

    expect((await service.usage(scope.organizationId, 'ai_micros')).used).toBe(250n);
  });

  it('keeps the period of the reservation for a call that ends in the next month', async () => {
    const { service, store } = setup('2026-10-31T23:59:59Z');
    const reservation = await service.reserve(scope, 'ai_micros', 100n);

    await reservation.finalize({ quantity: 80n, sourceType: 'ai_generation', sourceId: 'gen-1' });

    expect(reservation.periodStart).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(store.ledger[0]?.key.periodStart).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('rejects negative amounts', async () => {
    const { service } = setup();
    const reservation = await service.reserve(scope, 'ai_micros', 10n);

    await expect(service.reserve(scope, 'ai_micros', -1n)).rejects.toBeInstanceOf(RangeError);
    await expect(
      reservation.finalize({ quantity: -1n, sourceType: 'ai_generation', sourceId: 'gen-1' }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('refuses every reservation above zero at a limit of zero', async () => {
    const { service } = setup(undefined, 0n);

    await expect(service.reserve(scope, 'ai_micros', 1n)).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(service.reserve(scope, 'ai_micros', 0n)).resolves.toMatchObject({ reserved: 0n });
  });
});
