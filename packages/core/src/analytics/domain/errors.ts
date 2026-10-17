import { DomainError } from '../../shared/domain/errors';

/** The period starts before the history the plan keeps (guide step 5.4). */
export class AnalyticsHistoryExceededError extends DomainError {
  readonly code = 'ANALYTICS_HISTORY_EXCEEDED';
  readonly kind = 'invalid';
  override readonly params: { earliest: string };
  constructor(earliest: string) {
    super('The period starts before the analytics history of the plan.');
    this.params = { earliest };
  }
}
