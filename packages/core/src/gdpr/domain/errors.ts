import { DomainError } from '../../shared/domain/errors';

/** The export does not exist in the organization, has not finished or has expired (HTTP 404). */
export class DataExportUnavailableError extends DomainError {
  readonly code = 'DATA_EXPORT_UNAVAILABLE';
  readonly kind = 'not_found';
  constructor() {
    super('The export is not available for download.');
  }
}

/** The owner did not type the name of the organization to confirm its deletion (HTTP 422). */
export class OrganizationNameMismatchError extends DomainError {
  readonly code = 'ORGANIZATION_NAME_MISMATCH';
  readonly kind = 'invalid';
  constructor() {
    super('The confirmation does not match the name of the organization.');
  }
}

/**
 * The organization is deleted and waits for its erasure (HTTP 409). Its owners may still take the
 * deletion back and export its data; everything else is refused.
 */
export class OrganizationDeletionPendingError extends DomainError {
  readonly code = 'ORGANIZATION_DELETION_PENDING';
  readonly kind = 'conflict';
  constructor() {
    super('The organization is deleted and waits for its erasure.');
  }
}

/** No erasure waits that could be taken back; it ran already or was never requested (HTTP 409). */
export class ErasureNotPendingError extends DomainError {
  readonly code = 'ERASURE_NOT_PENDING';
  readonly kind = 'conflict';
  constructor() {
    super('No erasure of the organization is waiting.');
  }
}
