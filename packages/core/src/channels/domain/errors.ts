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

/** The deployment, the kill switch or the plan keeps the X browser closed (guide step 6.1). */
export class XBrowserUnavailableError extends DomainError {
  readonly code = 'X_BROWSER_UNAVAILABLE';
  // Not "forbidden": the role may switch it on, the state of the platform does not allow it.
  readonly kind = 'conflict';
  constructor() {
    super('The X browser is not available for this workspace.');
  }
}

/** The user read another version of the risk text than the current one. */
export class RiskTextOutdatedError extends DomainError {
  readonly code = 'RISK_TEXT_OUTDATED';
  readonly kind = 'conflict';
  constructor() {
    super('The risk text has a newer version.');
  }
}
