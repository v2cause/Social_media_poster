import { describe, expect, it } from 'vitest';

import {
  RewrapSecrets,
  type SealedSecretColumn,
  type SealedSecretOwner,
  type SealedSecretRow,
  type SealedSecretStore,
  type SecretRewrapper,
} from '../../src';

// Guide step 4.2: the re-wrap job moves every envelope of an old key to the active one, in
// batches across all workspaces, and leaves alone what changed meanwhile or cannot be opened.

const OLD = Uint8Array.of(1);
const ACTIVE = Uint8Array.of(2);
const LOST_KEY = Uint8Array.of(9);

/** Re-wraps OLD to ACTIVE; LOST_KEY stands for an envelope whose key left the keyring. */
const fakeRewrapper = (label: string, calls: string[]): SecretRewrapper => ({
  rewrap(sealed) {
    calls.push(`${label}:${String(sealed[0])}`);
    if (sealed[0] === LOST_KEY[0]) {
      return Promise.reject(new Error('UNKNOWN_KEY'));
    }
    return Promise.resolve(sealed[0] === OLD[0] ? ACTIVE : null);
  },
});

class InMemorySealedSecrets implements SealedSecretStore {
  readonly rows: Record<SealedSecretOwner, SealedSecretRow[]> = { connection: [], account: [] };
  /** Rows a token refresh changes between list and replace. */
  readonly refreshedMeanwhile = new Set<string>();
  readonly pages: string[] = [];

  list(owner: SealedSecretOwner, afterId: string | null, limit: number): Promise<SealedSecretRow[]> {
    this.pages.push(`${owner}>${afterId ?? '-'}`);
    const rows = this.rows[owner].filter((row) => afterId === null || row.id > afterId).slice(0, limit);
    return Promise.resolve(rows.map((row) => ({ ...row, secrets: { ...row.secrets } })));
  }

  replace(
    owner: SealedSecretOwner,
    id: string,
    column: SealedSecretColumn,
    previous: Uint8Array,
    next: Uint8Array,
  ): Promise<boolean> {
    const row = this.rows[owner].find((candidate) => candidate.id === id);
    if (!row || this.refreshedMeanwhile.has(id) || row.secrets[column] !== previous) {
      return Promise.resolve(false);
    }
    row.secrets[column] = next;
    return Promise.resolve(true);
  }
}

describe('RewrapSecrets', () => {
  it('re-wraps old envelopes in batches and counts the rest', async () => {
    const store = new InMemorySealedSecrets();
    store.rows.connection = [
      { id: 'c1', workspaceId: 'w1', secrets: { accessToken: OLD, refreshToken: OLD } },
      { id: 'c2', workspaceId: 'w2', secrets: { accessToken: ACTIVE, session: OLD } },
      { id: 'c3', workspaceId: 'w1', secrets: { accessToken: LOST_KEY } },
      { id: 'c4', workspaceId: 'w3', secrets: { refreshToken: OLD } },
    ];
    store.rows.account = [{ id: 'a1', workspaceId: 'w1', secrets: { accessToken: OLD } }];
    store.refreshedMeanwhile.add('c4');
    const calls: string[] = [];

    const report = await new RewrapSecrets({
      store,
      rewrappers: { tokens: fakeRewrapper('tokens', calls), sessions: fakeRewrapper('sessions', calls) },
      batchSize: 2,
    }).execute();

    expect(report).toEqual({ checked: 7, rewrapped: 4, changedMeanwhile: 1, failed: 1 });
    expect(store.pages).toEqual(['connection>-', 'connection>c2', 'connection>c4', 'account>-']);
    expect(store.rows.connection[0]?.secrets).toEqual({ accessToken: ACTIVE, refreshToken: ACTIVE });
    expect(store.rows.connection[1]?.secrets).toEqual({ accessToken: ACTIVE, session: ACTIVE });
    expect(store.rows.connection[2]?.secrets).toEqual({ accessToken: LOST_KEY });
    expect(store.rows.account[0]?.secrets).toEqual({ accessToken: ACTIVE });
    // Browser sessions go through their own keyring.
    expect(calls.filter((call) => call.startsWith('sessions'))).toEqual(['sessions:1']);
  });

  it('has nothing to do when every envelope uses the active key', async () => {
    const store = new InMemorySealedSecrets();
    store.rows.connection = [{ id: 'c1', workspaceId: 'w1', secrets: { accessToken: ACTIVE } }];
    const calls: string[] = [];

    const report = await new RewrapSecrets({
      store,
      rewrappers: { tokens: fakeRewrapper('tokens', calls), sessions: fakeRewrapper('sessions', calls) },
    }).execute();

    expect(report).toEqual({ checked: 1, rewrapped: 0, changedMeanwhile: 0, failed: 0 });
  });
});
