// Secrets of the channels at rest (guide step 4.2, architecture 10). Tokens and browser sessions
// are sealed one by one with envelope encryption. The AAD binds a ciphertext to its workspace,
// connection and field, so an envelope copied into another row or column does not open.

export const CONNECTION_SECRET_FIELDS = ['access_token', 'refresh_token', 'session'] as const;
export type ConnectionSecretField = (typeof CONNECTION_SECRET_FIELDS)[number];

/** The AAD of a secret of a connection: workspaceId:connectionId:field. */
export const connectionSecretAad = (
  workspaceId: string,
  connectionId: string,
  field: ConnectionSecretField,
): string => `${workspaceId}:${connectionId}:${field}`;

/** The AAD of the token of an account (a Facebook page), bound to the account as well. */
export const accountSecretAad = (workspaceId: string, connectionId: string, accountId: string): string =>
  `${workspaceId}:${connectionId}:account.${accountId}.access_token`;

/** The AAD of the tokens of a consent that waits for the selection of the accounts. */
export const pendingSecretAad = (workspaceId: string, pendingId: string): string =>
  `${workspaceId}:pending.${pendingId}:token_set`;

/** Browser sessions have a keyring of their own (SESSION_KEKS), tokens use TOKEN_KEKS. */
export type SecretKeyring = 'tokens' | 'sessions';

export type SealedSecretOwner = 'connection' | 'account';
export type SealedSecretColumn = 'accessToken' | 'refreshToken' | 'session';

/** The sealed columns of each owner and the keyring that seals them. */
export const SEALED_SECRET_COLUMNS: Readonly<
  Record<SealedSecretOwner, readonly { column: SealedSecretColumn; keyring: SecretKeyring }[]>
> = {
  connection: [
    { column: 'accessToken', keyring: 'tokens' },
    { column: 'refreshToken', keyring: 'tokens' },
    { column: 'session', keyring: 'sessions' },
  ],
  account: [{ column: 'accessToken', keyring: 'tokens' }],
};
