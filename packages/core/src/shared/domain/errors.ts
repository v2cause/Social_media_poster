/**
 * How the caller should treat a domain error. The API maps it to an HTTP status
 * (invalid 422, forbidden 403, not_found 404, conflict 409); the UI translates the code.
 */
export type DomainErrorKind = 'invalid' | 'forbidden' | 'not_found' | 'conflict';

/** A broken business rule with a stable code (guide B.1). Never carries secrets or PII. */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly kind: DomainErrorKind;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The actor's role does not allow the action. The guards check first; this is the second line. */
export class NotPermittedError extends DomainError {
  readonly code = 'NOT_PERMITTED';
  readonly kind = 'forbidden';
  constructor() {
    super('The role of the member does not allow this action.');
  }
}
