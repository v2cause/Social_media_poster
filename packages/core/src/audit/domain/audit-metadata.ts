import { DomainError } from '../../shared/domain/errors';

// Audit metadata describes a change; it never carries secrets (guide step 1.7). Keys that look
// like credentials are refused, so that a careless call fails in the tests instead of leaking.

const FORBIDDEN_KEY = /token|secret|password|passwd|hash|cookie|authorization|api[-_]?key|credential/i;

export class UnsafeAuditMetadataError extends DomainError {
  readonly code = 'UNSAFE_AUDIT_METADATA';
  readonly kind = 'invalid';
  constructor(key: string) {
    super(`Audit metadata must not contain secrets (key "${key}").`);
  }
}

export function assertSafeAuditMetadata(metadata: Record<string, unknown> | undefined): void {
  for (const key of Object.keys(metadata ?? {})) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new UnsafeAuditMetadataError(key);
    }
  }
}
