import type { XBrowserUnitOfWork } from '../ports/x-browser';

// The storage state after a task of the browser worker (guide step 6.2), sealed by the browser
// worker with the session keyring and reported on xb-results. It replaces the session of its
// connection as it comes; nothing here opens it.

export interface StoreBrowserSessionInput {
  organizationId: string;
  workspaceId: string;
  connectionId: string;
  externalUserId: string;
  sessionSealed: Uint8Array;
}

export class StoreBrowserSession {
  constructor(private readonly deps: { unitOfWork: XBrowserUnitOfWork }) {}

  /** False when the connection is gone or no longer this browser connection. */
  execute(input: StoreBrowserSessionInput): Promise<boolean> {
    const { organizationId, workspaceId } = input;
    return this.deps.unitOfWork.run({ organizationId, workspaceId }, (store) =>
      store.replaceSession(workspaceId, input.connectionId, input.externalUserId, input.sessionSealed),
    );
  }
}
