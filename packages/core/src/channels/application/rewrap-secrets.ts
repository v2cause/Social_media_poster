import { SEALED_SECRET_COLUMNS, type SealedSecretOwner, type SecretKeyring } from '../domain/secrets';
import type { SealedSecretStore, SecretRewrapper } from '../ports/secrets';

// The re-wrap job of a key rotation (guide step 4.2): every envelope whose data key an older KEK
// wraps gets wrapped by the active one, so the old key can leave the keyring afterwards. Nothing
// is decrypted. The write compares the bytes it read and leaves the version of the row alone: a
// token refresh running at the same time wins and stores its new token, sealed with the active
// key anyway. With X a lost refresh would cost the connection, because its refresh tokens are
// valid once. Envelopes the keyring cannot open are counted and left as they are.

const OWNERS: readonly SealedSecretOwner[] = ['connection', 'account'];
const DEFAULT_BATCH_SIZE = 200;

export interface RewrapReport {
  /** Sealed columns looked at. */
  checked: number;
  rewrapped: number;
  /** Changed by someone else between reading and writing; the next run checks them again. */
  changedMeanwhile: number;
  /** Not re-wrappable, for example because their key is no longer configured. */
  failed: number;
}

export class RewrapSecrets {
  constructor(
    private readonly deps: {
      store: SealedSecretStore;
      rewrappers: Readonly<Record<SecretKeyring, SecretRewrapper>>;
      batchSize?: number;
    },
  ) {}

  async execute(): Promise<RewrapReport> {
    const report: RewrapReport = { checked: 0, rewrapped: 0, changedMeanwhile: 0, failed: 0 };
    const limit = this.deps.batchSize ?? DEFAULT_BATCH_SIZE;
    for (const owner of OWNERS) {
      let afterId: string | null = null;
      for (;;) {
        const rows = await this.deps.store.list(owner, afterId, limit);
        for (const row of rows) {
          for (const { column, keyring } of SEALED_SECRET_COLUMNS[owner]) {
            const sealed = row.secrets[column];
            if (!sealed) {
              continue;
            }
            report.checked += 1;
            let next: Uint8Array | null;
            try {
              next = await this.deps.rewrappers[keyring].rewrap(sealed);
            } catch {
              report.failed += 1;
              continue;
            }
            if (next === null) {
              continue;
            }
            if (await this.deps.store.replace(owner, row.id, column, sealed, next)) {
              report.rewrapped += 1;
            } else {
              report.changedMeanwhile += 1;
            }
          }
        }
        const last = rows.at(-1);
        if (rows.length < limit || !last) {
          break;
        }
        afterId = last.id;
      }
    }
    return report;
  }
}
