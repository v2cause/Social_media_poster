// The key-encryption keys (KEK) of the envelopes (architecture 10): locally a keyring from the
// env, in the cloud AWS KMS or Vault. A KMS only ever sees data keys, never a secret itself.

export interface WrappedKey {
  /** The KEK that wrapped the data key; stored in the envelope. */
  keyId: string;
  wrappedKey: Uint8Array;
}

export interface KmsPort {
  /** The KEK that wraps new data keys. */
  readonly activeKeyId: string;
  /** Wraps a data key with the active KEK. */
  wrapKey(dataKey: Uint8Array): Promise<WrappedKey>;
  /**
   * Unwraps a data key. Throws a SealedSecretError: UNKNOWN_KEY when the KEK is not configured,
   * INVALID when the wrapped key does not authenticate.
   */
  unwrapKey(keyId: string, wrappedKey: Uint8Array): Promise<Uint8Array>;
}
