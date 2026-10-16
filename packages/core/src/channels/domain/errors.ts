import { DomainError } from '../../shared/domain/errors';

export class ChannelUnavailableError extends DomainError {
  readonly code = 'CHANNEL_UNAVAILABLE';
  readonly kind = 'invalid';
  constructor() {
    super('The platform cannot be connected with this configuration.');
  }
}

export class SocialAccountNotFoundError extends DomainError {
  readonly code = 'SOCIAL_ACCOUNT_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The account does not exist in this workspace or is disconnected.');
  }
}

/** Expired, confirmed already, or the consent of someone else. */
export class PendingConnectionNotFoundError extends DomainError {
  readonly code = 'PENDING_CONNECTION_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The pending connection does not exist or has expired.');
  }
}

export class InvalidAccountSelectionError extends DomainError {
  readonly code = 'INVALID_ACCOUNT_SELECTION';
  readonly kind = 'invalid';
  constructor() {
    super('The selection names an account the consent does not reach.');
  }
}
