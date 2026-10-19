import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  /** The x-request-id a client sent, kept apart from the ID the API gives the request. */
  clientRequestId?: string;
  jobId?: string;
  /** The queue and the name of the job of a worker. */
  queue?: string;
  job?: string;
  userId?: string;
  organizationId?: string;
  workspaceId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs fn with extra fields that every log line written inside it carries. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/**
 * Adds fields to the context that is already running, for the rest of it: the request pipeline
 * learns the user and the workspace only after the request began. Outside a context it does nothing.
 */
export function addToLogContext(
  context: Pick<LogContext, 'userId' | 'organizationId' | 'workspaceId'>,
): void {
  const store = storage.getStore();
  if (store) {
    Object.assign(store, context);
  }
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
