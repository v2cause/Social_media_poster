import type {
  BrowserLogin,
  BrowserLoginCommand,
  BrowserLoginEvents,
  BrowserLoginQueue,
  BrowserLoginStore,
} from '../src';

// In-memory adapters for the interactive login of X: the logins with their codes and the count
// of starts per hour, as Redis keeps them, the queue of the browser worker and the live events.

export class MemoryBrowserLogins implements BrowserLoginStore {
  readonly logins = new Map<string, BrowserLogin>();
  readonly codes = new Map<string, Uint8Array[]>();
  readonly starts = new Map<string, number>();

  create(login: BrowserLogin): Promise<void> {
    this.logins.set(login.id, { ...login });
    return Promise.resolve();
  }

  find(id: string): Promise<BrowserLogin | null> {
    const login = this.logins.get(id);
    return Promise.resolve(login ? { ...login } : null);
  }

  transition(
    id: string,
    from: Parameters<BrowserLoginStore['transition']>[1],
    change: Parameters<BrowserLoginStore['transition']>[2],
  ): Promise<BrowserLogin | null> {
    const login = this.logins.get(id);
    if (!login || !from.includes(login.status)) {
      return Promise.resolve(null);
    }
    const next: BrowserLogin = {
      ...login,
      status: change.status,
      failure: change.failure ?? login.failure,
      accountId: change.accountId ?? login.accountId,
    };
    this.logins.set(id, next);
    return Promise.resolve({ ...next });
  }

  pushCode(id: string, sealed: Uint8Array): Promise<void> {
    this.codes.set(id, [...(this.codes.get(id) ?? []), sealed]);
    return Promise.resolve();
  }

  countStart(workspaceId: string, at: Date): Promise<number> {
    const key = `${workspaceId}:${String(Math.floor(at.getTime() / 3_600_000))}`;
    const count = (this.starts.get(key) ?? 0) + 1;
    this.starts.set(key, count);
    return Promise.resolve(count);
  }
}

export class RecordingLoginQueue implements BrowserLoginQueue {
  readonly commands: BrowserLoginCommand[] = [];

  start(command: BrowserLoginCommand): Promise<void> {
    this.commands.push(command);
    return Promise.resolve();
  }
}

export class RecordingLoginEvents implements BrowserLoginEvents {
  readonly events: Pick<BrowserLogin, 'id' | 'userId' | 'status'>[] = [];

  changed(login: BrowserLogin): Promise<void> {
    this.events.push({ id: login.id, userId: login.userId, status: login.status });
    return Promise.resolve();
  }
}
