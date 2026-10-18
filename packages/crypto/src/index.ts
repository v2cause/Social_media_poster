// Envelope encryption and key management (local keyring, KMS adapters), and link tokens.

export {
  ENVELOPE_VERSION,
  keyIdOf,
  open,
  rewrap,
  seal,
  SealedSecretError,
  type SealedSecretErrorCode,
} from './envelope';
export { EnvelopeSealer, KEYRING_ENV, sealerFromEnv } from './envelope-sealer';
export type { KmsPort, WrappedKey } from './kms';
export { KeyringConfigError, LocalKeyring } from './local-keyring';
export { oauthRandom } from './oauth-random';
export { secretTokens, sha256Hex } from './secret-tokens';
export { hashPassword, verifyPassword } from './password-hash';
