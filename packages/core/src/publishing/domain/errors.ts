import type { VariantStatus } from '../../content/domain/types';
import { DomainError } from '../../shared/domain/errors';

/** The state machine of architecture 7.2 does not lead from the current status to the next one. */
export class InvalidTransitionError extends DomainError {
  readonly code = 'INVALID_STATUS_TRANSITION';
  readonly kind = 'conflict';
  override readonly params: { from: VariantStatus; to: VariantStatus };
  constructor(from: VariantStatus, to: VariantStatus) {
    super(`A variant cannot go from ${from} to ${to}.`);
    this.params = { from, to };
  }
}

export class InvalidScheduleTimeError extends DomainError {
  readonly code = 'INVALID_SCHEDULE_TIME';
  readonly kind = 'invalid';
  constructor() {
    super('The time is not a local date and time in a known time zone.');
  }
}

export class ScheduleTimeInPastError extends DomainError {
  readonly code = 'SCHEDULE_TIME_IN_PAST';
  readonly kind = 'invalid';
  constructor() {
    super('A variant can only be planned for a time in the future.');
  }
}

/** The local time falls into the gap of a change to daylight saving time. */
export class ScheduleTimeInGapError extends DomainError {
  readonly code = 'SCHEDULE_TIME_IN_GAP';
  readonly kind = 'invalid';
  override readonly params: { suggestion: string; timeZone: string };
  constructor(suggestion: string, timeZone: string) {
    super('The local time does not exist in the time zone because of a change of the clocks.');
    this.params = { suggestion, timeZone };
  }
}

export class SocialAccountRequiredError extends DomainError {
  readonly code = 'SOCIAL_ACCOUNT_REQUIRED';
  readonly kind = 'invalid';
  constructor() {
    super('The variant needs an account to publish to.');
  }
}

/** The account is disconnected, of another platform, or its connection needs a new grant. */
export class SocialAccountNotReadyError extends DomainError {
  readonly code = 'SOCIAL_ACCOUNT_NOT_READY';
  readonly kind = 'invalid';
  override readonly params: { reason: string };
  constructor(reason: 'DISCONNECTED' | 'PLATFORM_MISMATCH' | 'NEEDS_REAUTH' | 'PAUSED' | 'REVOKED') {
    super(`The account cannot publish: ${reason}.`);
    this.params = { reason };
  }
}

/** The content breaks a rule of the platform, or there is nothing to publish. */
export class VariantNotPublishableError extends DomainError {
  readonly code = 'VARIANT_NOT_PUBLISHABLE';
  readonly kind = 'invalid';
  override readonly params: { issues: readonly string[] };
  constructor(issues: readonly string[]) {
    super(`The variant cannot be published: ${issues.join(', ')}.`);
    this.params = { issues };
  }
}
