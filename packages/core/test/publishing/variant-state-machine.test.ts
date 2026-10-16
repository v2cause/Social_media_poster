import { describe, expect, it } from 'vitest';

import { VARIANT_STATUSES, type VariantStatus } from '../../src';
import { canTransition, VARIANT_TRANSITIONS } from '../../src/publishing/domain/variant-state-machine';

// Guide step 4.6, "Fertig, wenn": every allowed and every forbidden transition of architecture
// 7.2 as a table. The table lists the allowed ones; every other pair must be refused.

const ALLOWED: readonly (readonly [VariantStatus, VariantStatus, string])[] = [
  ['DRAFT', 'SCHEDULED', 'plan'],
  ['DRAFT', 'QUEUED', 'post now'],
  ['SCHEDULED', 'DRAFT', 'back to draft'],
  ['SCHEDULED', 'SCHEDULED', 'reschedule'],
  ['SCHEDULED', 'QUEUED', 'due, or post now'],
  ['SCHEDULED', 'CANCELED', 'cancel'],
  ['SCHEDULED', 'FAILED', 'missed window'],
  ['QUEUED', 'SCHEDULED', 'reschedule'],
  ['QUEUED', 'PUBLISHING', 'job takes over'],
  ['QUEUED', 'CANCELED', 'cancel before the job runs'],
  ['QUEUED', 'FAILED', 'missed window'],
  ['PUBLISHING', 'PUBLISHING', 'job takes over after the lease ran out'],
  ['PUBLISHING', 'PUBLISHED', 'ok'],
  ['PUBLISHING', 'RETRYING', 'temporary error'],
  ['PUBLISHING', 'FAILED', 'final error'],
  ['PUBLISHING', 'NEEDS_ATTENTION', 'unclear outcome'],
  ['RETRYING', 'PUBLISHING', 'backoff over'],
  ['RETRYING', 'FAILED', 'attempts used up'],
  ['RETRYING', 'CANCELED', 'cancel between attempts'],
  ['PUBLISHED', 'DELETED', 'delete'],
  ['FAILED', 'DRAFT', 'edit'],
  ['FAILED', 'SCHEDULED', 'again'],
  ['FAILED', 'QUEUED', 'again now'],
  ['NEEDS_ATTENTION', 'PUBLISHED', 'reconcile found the post'],
  ['NEEDS_ATTENTION', 'SCHEDULED', 'again'],
  ['NEEDS_ATTENTION', 'QUEUED', 'check again or post anyway'],
  ['NEEDS_ATTENTION', 'CANCELED', 'discard'],
  ['CANCELED', 'DRAFT', 'edit'],
  ['CANCELED', 'SCHEDULED', 'plan again'],
  ['CANCELED', 'QUEUED', 'post now'],
];

const allowed = new Set(ALLOWED.map(([from, to]) => `${from}>${to}`));
const pairs = VARIANT_STATUSES.flatMap((from) => VARIANT_STATUSES.map((to) => [from, to] as const));

describe('the state machine of a variant', () => {
  it.each(ALLOWED)('allows %s to %s (%s)', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(pairs.filter(([from, to]) => !allowed.has(`${from}>${to}`)))('refuses %s to %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('lists nothing beyond the table and ends in DELETED', () => {
    const listed = Object.entries(VARIANT_TRANSITIONS).flatMap(([from, targets]) =>
      targets.map((to) => `${from}>${to}`),
    );
    expect(new Set(listed)).toEqual(allowed);
    expect(VARIANT_TRANSITIONS.DELETED).toEqual([]);
  });
});
