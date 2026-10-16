import { z } from 'zod';

import type { ConnectableAccount, OAuthGrant } from '../ports/platform-adapter';

// The tokens of a consent while it waits for the selection of the accounts (guide step 4.5):
// sealed as one envelope with pendingSecretAad, opened once on confirmation.

const pendingSecretsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  accessTokenExpiresAt: z.iso.datetime().nullable(),
  refreshTokenExpiresAt: z.iso.datetime().nullable(),
  /** The tokens of the accounts that have their own, by external id. */
  accounts: z.record(z.string(), z.string().min(1)),
});
export type PendingSecrets = z.infer<typeof pendingSecretsSchema>;

export const pendingSecretsOf = (grant: OAuthGrant, accounts: readonly ConnectableAccount[]): string =>
  JSON.stringify({
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    accessTokenExpiresAt: grant.accessTokenExpiresAt?.toISOString() ?? null,
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt?.toISOString() ?? null,
    accounts: Object.fromEntries(
      accounts.flatMap((account) => (account.accessToken ? [[account.externalId, account.accessToken]] : [])),
    ),
  } satisfies PendingSecrets);

export const parsePendingSecrets = (text: string): PendingSecrets =>
  pendingSecretsSchema.parse(JSON.parse(text));
