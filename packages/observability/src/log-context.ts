import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  jobId?: string;
  workspaceId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs fn with extra fields that every log line written inside it carries. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
