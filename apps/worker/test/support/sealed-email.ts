import { randomBytes } from 'node:crypto';

import { sealerFromEnv } from '@smp/crypto';
import { openNotifyEmail, parseNotifyDispatch, type SealedEmail } from '@smp/queue';

// The emails of the notify jobs travel sealed with the token keyring (guide step 8.4). A test
// gives the worker a keyring of its own and opens the queued emails with it.

/** TOKEN_KEKS and TOKEN_KEK_ACTIVE, as the env of a worker takes them. */
export type TokenKeys = Record<'TOKEN_KEKS' | 'TOKEN_KEK_ACTIVE', string>;

/** A fresh token keyring with one key. */
export const tokenKeys = (): TokenKeys => ({
  TOKEN_KEKS: `kek-test:${randomBytes(32).toString('base64')}`,
  TOKEN_KEK_ACTIVE: 'kek-test',
});

/** The address and the email of a notify job, opened with the keyring the worker sealed it with. */
export async function openedEmail(keys: TokenKeys, data: unknown): Promise<SealedEmail> {
  const dispatch = parseNotifyDispatch(data);
  if (dispatch.channel !== 'email') {
    throw new Error(`expected an email job, got one of the channel ${dispatch.channel}`);
  }
  return openNotifyEmail(sealerFromEnv('tokens', keys), dispatch);
}
