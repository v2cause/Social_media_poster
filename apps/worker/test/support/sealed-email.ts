import { randomBytes } from 'node:crypto';

import { notifySealerFromEnv } from '@smp/crypto';
import { openNotifyEmail, parseNotifyDispatch, type SealedEmail } from '@smp/queue';

// The emails of the notify jobs travel sealed with the keyring of the e-mails (guide steps 8.4 and
// 8.9). A test gives the worker keyrings of its own, the e-mails under another key ID than the
// tokens, so that an email sealed with the token keyring does not open.

/** TOKEN_KEKS and TOKEN_KEK_ACTIVE, as the env of a worker takes them. */
export type TokenKeys = Record<'TOKEN_KEKS' | 'TOKEN_KEK_ACTIVE', string>;
/** NOTIFY_KEKS and NOTIFY_KEK_ACTIVE, as the env of a worker takes them. */
export type NotifyKeys = Record<'NOTIFY_KEKS' | 'NOTIFY_KEK_ACTIVE', string>;

const freshKey = (): string => randomBytes(32).toString('base64');

/** A fresh token keyring with one key. */
export const tokenKeys = (): TokenKeys => ({
  TOKEN_KEKS: `kek-test:${freshKey()}`,
  TOKEN_KEK_ACTIVE: 'kek-test',
});

/** A fresh keyring of the e-mails with one key. */
export const notifyKeys = (): NotifyKeys => ({
  NOTIFY_KEKS: `ntf-test:${freshKey()}`,
  NOTIFY_KEK_ACTIVE: 'ntf-test',
});

/** The address and the email of a notify job, opened with the keyring the worker sealed it with. */
export async function openedEmail(keys: NotifyKeys, data: unknown): Promise<SealedEmail> {
  const dispatch = parseNotifyDispatch(data);
  if (dispatch.channel !== 'email') {
    throw new Error(`expected an email job, got one of the channel ${dispatch.channel}`);
  }
  return openNotifyEmail(notifySealerFromEnv(keys), dispatch);
}
