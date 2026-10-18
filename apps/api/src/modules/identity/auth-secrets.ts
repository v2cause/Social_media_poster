import type { SecretConfig } from 'better-auth/crypto';

import type { ApiEnv } from '../../config/api-env';

// The keys of Better Auth (guide step 8.4, docs/runbooks/secret-rotation.md). Without
// BETTER_AUTH_SECRETS there is one key; with it the versions, the current one first, and
// BETTER_AUTH_SECRET for what was encrypted before versions existed.

export function authSecretConfig(
  env: Pick<ApiEnv, 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_SECRETS'>,
): SecretConfig | null {
  const [current] = env.BETTER_AUTH_SECRETS ?? [];
  if (!env.BETTER_AUTH_SECRETS || !current) {
    return null;
  }
  return {
    keys: new Map(env.BETTER_AUTH_SECRETS.map((entry) => [entry.version, entry.value])),
    currentVersion: current.version,
    legacySecret: env.BETTER_AUTH_SECRET,
  };
}
