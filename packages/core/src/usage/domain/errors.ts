import { DomainError } from '../../shared/domain/errors';
import type { UsageMeter } from './meters';

/** The reservation would take the counter of the period over its limit (HTTP 402). */
export class QuotaExceededError extends DomainError {
  readonly code = 'QUOTA_EXCEEDED';
  readonly kind = 'quota_exceeded';

  constructor(readonly meter: UsageMeter) {
    super(`The ${meter} quota of the current period is used up.`);
  }
}
