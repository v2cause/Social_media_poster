import { DomainError } from '../../shared/domain/errors';
import type { AiFailure } from './types';

/**
 * A call that does not stream failed (ideas, voice test). Streaming calls send the failure as a
 * generation.failed event instead. A refusal is about the request (422); everything else is the
 * provider's side (503), and the UI offers to try again.
 */
export class AiCallFailedError extends DomainError {
  readonly code: string;
  readonly kind: 'invalid' | 'unavailable';
  readonly retryable: boolean;

  constructor(failure: Pick<AiFailure, 'code' | 'retryable'>) {
    super(`The AI call failed: ${failure.code}.`);
    this.code = `AI_${failure.code}`;
    this.kind = failure.code === 'REFUSED' ? 'invalid' : 'unavailable';
    this.retryable = failure.retryable;
  }
}
