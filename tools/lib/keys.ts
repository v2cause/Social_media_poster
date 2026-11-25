import { randomBytes, randomUUID } from 'node:crypto';

// Fresh secrets for .env: the Better Auth secret and the keyrings of tokens, sessions and e-mails.
// Shared by `pnpm gen:keys` (prints them) and `pnpm local` (fills the empty ones in .env).

const KEY_BYTES = 32;

const newKey = (): string => randomBytes(KEY_BYTES).toString('base64');

function newKeyring(prefix: string): Record<string, string> {
  const id = `kek-${randomUUID().slice(0, 8)}`;
  return { [`${prefix}_KEKS`]: `${id}:${newKey()}`, [`${prefix}_KEK_ACTIVE`]: id };
}

/** The secrets as variable name and value, in the order of .env.example. */
export function generateKeys(): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: newKey(),
    ...newKeyring('TOKEN'),
    ...newKeyring('SESSION'),
    ...newKeyring('NOTIFY'),
  };
}
