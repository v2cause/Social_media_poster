import type { BrowserLoginCommand, BrowserLoginQueue } from '@smp/core';
import { xbCommandName, xbCommandSchemas, type XbCommand } from '@smp/x-browser';
import type { Queue } from 'bullmq';

// The start of a login of X on xb-commands (guide step 6.4). Its job carries the credentials,
// sealed for the browser worker, and leaves Redis as soon as it ends, whether it succeeded or
// failed; nobody awaits its return value, the steps come back as reports on xb-results.

export class BullBrowserLoginQueue implements BrowserLoginQueue {
  constructor(private readonly queue: Queue) {}

  async start(command: BrowserLoginCommand): Promise<void> {
    const data: XbCommand<'login.start'> = xbCommandSchemas['login.start'].parse({
      commandId: command.commandId,
      deadline: command.deadline.toISOString(),
      organizationId: command.organizationId,
      workspaceId: command.workspaceId,
      loginSessionId: command.loginSessionId,
      locale: command.locale,
      expiresAt: command.expiresAt.toISOString(),
      credentials: Buffer.from(command.credentialsSealed).toString('base64'),
    });
    await this.queue.add(xbCommandName('login.start'), data, {
      jobId: `xb.login.start.${command.loginSessionId}`,
      // A login that fails is started again by its user, never by the queue.
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}
