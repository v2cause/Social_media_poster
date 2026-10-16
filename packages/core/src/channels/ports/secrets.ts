import type { SealedSecretColumn, SealedSecretOwner } from '../domain/secrets';

// Envelope encryption of secrets (guide step 4.2), implemented in @smp/crypto, and the sealed
// columns of all workspaces for the re-wrap job, implemented in @smp/db.

export interface SecretSealer {
  seal(plaintext: string, aad: string): Promise<Uint8Array>;
  /** Throws when the envelope is damaged, the AAD differs or its key is not configured. */
  open(sealed: Uint8Array, aad: string): Promise<string>;
}

export interface SecretRewrapper {
  /** The envelope wrapped with the active key, or null when it already is. */
  rewrap(sealed: Uint8Array): Promise<Uint8Array | null>;
}

export interface SealedSecretRow {
  id: string;
  workspaceId: string;
  secrets: Partial<Record<SealedSecretColumn, Uint8Array>>;
}

/** Runs across all workspaces (app_system). */
export interface SealedSecretStore {
  /** Up to limit rows with at least one sealed column after the given id, in id order. */
  list(owner: SealedSecretOwner, afterId: string | null, limit: number): Promise<SealedSecretRow[]>;
  /**
   * Stores next if the column still holds previous; false when it changed meanwhile. Leaves the
   * version of the row alone.
   */
  replace(
    owner: SealedSecretOwner,
    id: string,
    column: SealedSecretColumn,
    previous: Uint8Array,
    next: Uint8Array,
  ): Promise<boolean>;
}
