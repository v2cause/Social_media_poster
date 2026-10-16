/** Random tokens for links and their hashes. Only hashes are stored. */
export interface SecretTokens {
  /** A token from 32 random bytes and its SHA-256 hash. */
  create(): { token: string; hash: string };
  hash(token: string): string;
  /** A short random suffix for workspace slugs, for example "k3x9". */
  slugSuffix(): string;
}
