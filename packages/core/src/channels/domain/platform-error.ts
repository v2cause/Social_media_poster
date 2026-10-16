// The error taxonomy of the platform adapters (architecture 4.1). The publish job reacts to the
// code (architecture 7.1); the message never contains tokens or response bodies.

export const PLATFORM_ERROR_CODES = [
  'AUTH_EXPIRED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'VALIDATION_REJECTED',
  'DUPLICATE',
  'MEDIA_PROCESSING',
  'TRANSIENT',
  'OUTCOME_UNKNOWN',
  'CHALLENGE_REQUIRED',
  'SELECTOR_DRIFT',
  'SPEND_CAP_REACHED',
] as const;
export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];

/** Codes whose cause passes, so trying again later can succeed. */
const RETRYABLE: ReadonlySet<PlatformErrorCode> = new Set(['RATE_LIMITED', 'MEDIA_PROCESSING', 'TRANSIENT']);

export interface PlatformErrorDetails {
  /** Overrides the default of the code. */
  retryable?: boolean;
  /** How long the platform asks to wait, from Retry-After or its rate headers. */
  retryAfterMs?: number;
  /** The HTTP status, if there was a response. */
  status?: number;
  /** The error code of the platform, for example 190 at Meta. */
  platformCode?: string;
}

// A brand in the global symbol registry: instanceof fails when a bundle or test runner loads this
// module twice, the brand does not.
const BRAND = Symbol.for('smp.PlatformError');

export class PlatformError extends Error {
  readonly [BRAND] = true;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly platformCode: string | undefined;

  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    details: PlatformErrorDetails = {},
  ) {
    super(message);
    this.name = 'PlatformError';
    this.retryable = details.retryable ?? RETRYABLE.has(code);
    this.retryAfterMs = details.retryAfterMs;
    this.status = details.status;
    this.platformCode = details.platformCode;
  }
}

export const isPlatformError = (error: unknown): error is PlatformError =>
  typeof error === 'object' && error !== null && (error as Partial<Record<symbol, unknown>>)[BRAND] === true;
