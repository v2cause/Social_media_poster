import type { VariantListItemDto } from '@smp/contracts';

// Which statuses of a variant allow which step in the views of guide step 4.11, after the state
// machine of architecture 7.2. The API checks every step again.

export type VariantStatusDto = VariantListItemDto['status'];

/** A plan that can still be canceled. */
export const CANCELABLE_STATUSES: readonly VariantStatusDto[] = ['SCHEDULED', 'QUEUED', 'RETRYING'];
