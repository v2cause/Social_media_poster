// How a flow of the browser fails (guide steps 6.2 and 6.3): the codes of the error taxonomy
// (architecture 4.1) and those of the login. A selector or an answer of X that no longer matches
// the selector map names its entry, so the drift report and the circuit breaker can count it.

export const FLOW_ERROR_CODES = [
  'AUTH_EXPIRED',
  'CHALLENGE_REQUIRED',
  'SELECTOR_DRIFT',
  'RATE_LIMITED',
  'VALIDATION_REJECTED',
  'DUPLICATE',
  'TRANSIENT',
  'OUTCOME_UNKNOWN',
  'INVALID_CREDENTIALS',
  'INVALID_CODE',
  'TIMEOUT',
] as const;
export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[number];

export interface FlowErrorDetails {
  /** The entry of the selector map that did not match, for example composer.textbox. */
  selector?: string;
  /** For RATE_LIMITED: when X lets the account try again. */
  retryAfterMs?: number;
}

export class FlowError extends Error {
  readonly selector: string | null;
  readonly retryAfterMs: number | null;

  constructor(
    readonly code: FlowErrorCode,
    message: string,
    details: FlowErrorDetails = {},
  ) {
    super(message);
    this.name = 'FlowError';
    this.selector = details.selector ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

export const isFlowError = (error: unknown): error is FlowError => error instanceof FlowError;

/** The failure of a missing or changed entry of the selector map. */
export const drift = (selector: string, message = `The selector ${selector} no longer matches.`): FlowError =>
  new FlowError('SELECTOR_DRIFT', message, { selector });
