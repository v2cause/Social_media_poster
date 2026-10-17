import { DomainError } from '../../shared/domain/errors';

/** The export does not exist in the organization, has not finished or has expired (HTTP 404). */
export class DataExportUnavailableError extends DomainError {
  readonly code = 'DATA_EXPORT_UNAVAILABLE';
  readonly kind = 'not_found';
  constructor() {
    super('The export is not available for download.');
  }
}
