import { DomainError } from '../../shared/domain/errors';

export class EmailNotVerifiedError extends DomainError {
  readonly code = 'EMAIL_NOT_VERIFIED';
  readonly kind = 'forbidden';
  constructor() {
    super('The email address must be verified first.');
  }
}

export class LastOwnerError extends DomainError {
  readonly code = 'LAST_OWNER';
  readonly kind = 'conflict';
  constructor() {
    super('An organization needs at least one owner.');
  }
}

export class RoleChangeForbiddenError extends DomainError {
  readonly code = 'ROLE_CHANGE_FORBIDDEN';
  readonly kind = 'forbidden';
  constructor() {
    super('Only owners can grant the owner role or manage owners.');
  }
}

export class MemberNotFoundError extends DomainError {
  readonly code = 'MEMBER_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The member does not exist in this organization.');
  }
}

export class CannotRemoveSelfError extends DomainError {
  readonly code = 'CANNOT_REMOVE_SELF';
  readonly kind = 'invalid';
  constructor() {
    super('Leave the organization instead of removing yourself.');
  }
}

export class AlreadyMemberError extends DomainError {
  readonly code = 'ALREADY_MEMBER';
  readonly kind = 'conflict';
  constructor() {
    super('The person is already a member of this organization.');
  }
}

export class InvalidWorkspaceSelectionError extends DomainError {
  readonly code = 'INVALID_WORKSPACES';
  readonly kind = 'invalid';
  constructor() {
    super('Every selected workspace must belong to the organization.');
  }
}

export class InvitationNotFoundError extends DomainError {
  readonly code = 'INVITATION_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The invitation does not exist.');
  }
}

export class InvitationExpiredError extends DomainError {
  readonly code = 'INVITATION_EXPIRED';
  readonly kind = 'conflict';
  constructor() {
    super('The invitation has expired.');
  }
}

export class InvitationUsedError extends DomainError {
  readonly code = 'INVITATION_USED';
  readonly kind = 'conflict';
  constructor() {
    super('The invitation was already accepted or revoked.');
  }
}

export class InvitationEmailMismatchError extends DomainError {
  readonly code = 'INVITATION_EMAIL_MISMATCH';
  readonly kind = 'forbidden';
  constructor() {
    super('The invitation was sent to another email address.');
  }
}

export class SlugUnavailableError extends DomainError {
  readonly code = 'SLUG_UNAVAILABLE';
  readonly kind = 'conflict';
  constructor() {
    super('No free workspace address could be found.');
  }
}

export class WorkspaceNotFoundError extends DomainError {
  readonly code = 'WORKSPACE_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The workspace does not exist.');
  }
}

export class OrganizationNotFoundError extends DomainError {
  readonly code = 'ORGANIZATION_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The organization does not exist.');
  }
}

/** The organization requires a second factor, and the user has none yet (guide step 8.4). */
export class TwoFactorRequiredError extends DomainError {
  readonly code = 'TWO_FACTOR_REQUIRED';
  readonly kind = 'forbidden';
  constructor() {
    super('The organization requires a second factor; set one up on the security page first.');
  }
}

/** An owner without a second factor cannot require one of everybody, including themselves. */
export class TwoFactorSetupRequiredError extends DomainError {
  readonly code = 'TWO_FACTOR_SETUP_REQUIRED';
  readonly kind = 'conflict';
  constructor() {
    super('Set up your own second factor before you require one of every member.');
  }
}

/**
 * The user created as many organizations as a period allows (guide step 8.4, HTTP 429). Each one
 * starts a trial with AI credit and storage.
 */
export class OrganizationLimitReachedError extends DomainError {
  readonly code = 'ORGANIZATION_LIMIT_REACHED';
  readonly kind = 'rate_limited';
  override readonly params: { max: number; days: number };

  constructor(max: number, days: number) {
    super(`A user creates at most ${String(max)} organizations in ${String(days)} days.`);
    this.params = { max, days };
  }
}
