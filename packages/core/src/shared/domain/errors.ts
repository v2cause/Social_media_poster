/**
 * How the caller should treat a domain error. The API maps it to an HTTP status
 * (invalid 422, forbidden 403, not_found 404, conflict 409, quota_exceeded 402, unavailable 503);
 * the UI translates the code.
 */
export type DomainErrorKind =
  'invalid' | 'forbidden' | 'not_found' | 'conflict' | 'quota_exceeded' | 'unavailable';

// A global symbol, so that the check works across copies of this package, for example when a
// test runner loads it once transformed and once through require().
const DOMAIN_ERROR = Symbol.for('smp.domain-error');

/** A broken business rule with a stable code (guide B.1). Never carries secrets or PII. */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly kind: DomainErrorKind;
  readonly [DOMAIN_ERROR] = true;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** True for every DomainError, whichever copy of the package created it. */
export const isDomainError = (error: unknown): error is DomainError =>
  error instanceof Error && (error as Partial<Record<typeof DOMAIN_ERROR, unknown>>)[DOMAIN_ERROR] === true;

/** The actor's role does not allow the action. The guards check first; this is the second line. */
export class NotPermittedError extends DomainError {
  readonly code = 'NOT_PERMITTED';
  readonly kind = 'forbidden';
  constructor() {
    super('The role of the member does not allow this action.');
  }
}
