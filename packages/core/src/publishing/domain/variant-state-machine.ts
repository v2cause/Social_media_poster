import type { VariantStatus } from '../../content/domain/types';

// The state machine of a PostVariant (architecture 7.2) as a plain transition table. Use cases
// and jobs ask it before every status change and store the change with a version check.
//
// Beyond the diagram of 7.2: "Jetzt posten" goes to QUEUED straight away (from a draft, a plan,
// a cancellation or a failure); a queued or retrying variant can still be canceled, its job then
// finds the variant moved on; a variant waiting for attention can be checked again or posted
// anyway (QUEUED) or discarded (CANCELED); editing a failed or canceled variant makes it a draft
// again; a job takes over a variant whose lease ran out (PUBLISHING to PUBLISHING).

export const VARIANT_TRANSITIONS: Readonly<Record<VariantStatus, readonly VariantStatus[]>> = {
  DRAFT: ['SCHEDULED', 'QUEUED'],
  SCHEDULED: ['DRAFT', 'SCHEDULED', 'QUEUED', 'CANCELED', 'FAILED'],
  QUEUED: ['SCHEDULED', 'PUBLISHING', 'CANCELED', 'FAILED'],
  PUBLISHING: ['PUBLISHING', 'PUBLISHED', 'RETRYING', 'FAILED', 'NEEDS_ATTENTION'],
  RETRYING: ['PUBLISHING', 'FAILED', 'CANCELED'],
  PUBLISHED: ['DELETED'],
  FAILED: ['DRAFT', 'SCHEDULED', 'QUEUED'],
  NEEDS_ATTENTION: ['PUBLISHED', 'SCHEDULED', 'QUEUED', 'CANCELED'],
  CANCELED: ['DRAFT', 'SCHEDULED', 'QUEUED'],
  DELETED: [],
};

export const canTransition = (from: VariantStatus, to: VariantStatus): boolean =>
  VARIANT_TRANSITIONS[from].includes(to);
