import { createServer, type Server } from 'node:net';
import { inspect } from 'node:util';

import { startConnectRecorder } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSmtpMailer, SmtpDeliveryError } from './smtp-mailer';

// Guide step 8.4: production never sends a mail in plain text. A server that offers no STARTTLS,
// like Mailpit locally, takes the mail only when TLS is not required. The error of a failed
// delivery names neither the address nor the reply of the server: a failed job keeps it.

/** An SMTP server without STARTTLS that accepts every mail, or rejects every recipient. */
function plainSmtpServer({ rejectRecipients = false } = {}): Server {
  return createServer((socket) => {
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\r\n')) {
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO') {
          socket.write('250-test\r\n250 SIZE 10240000\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (command === 'RCPT' && rejectRecipients) {
          // As real servers do, the reply names the address.
          socket.write(`550 5.1.1 ${line.slice(line.indexOf('<'))}: Recipient address rejected\r\n`);
        } else if (line.toUpperCase() === 'STARTTLS') {
          socket.write('502 5.5.1 STARTTLS not implemented\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 bye\r\n');
        } else if (line.length > 0) {
          socket.write('250 ok\r\n');
        }
      }
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `smtp://127.0.0.1:${typeof address === 'object' && address ? String(address.port) : '0'}`;
}

describe('createSmtpMailer', () => {
  const accepting = plainSmtpServer();
  const rejecting = plainSmtpServer({ rejectRecipients: true });
  let url = '';
  let rejectingUrl = '';
  let closedUrl = '';

  beforeAll(async () => {
    [url, rejectingUrl] = await Promise.all([listen(accepting), listen(rejecting)]);
    const closed = createServer();
    closedUrl = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
  });

  afterAll(async () => {
    await Promise.all(
      [accepting, rejecting].map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  const message = { to: 'ada@example.test', subject: 'Hallo', html: '<p>Hallo</p>', text: 'Hallo' };
  const failureOf = (mailer: ReturnType<typeof createSmtpMailer>): Promise<unknown> =>
    mailer.send(message).then(
      () => undefined,
      (error: unknown) => error,
    );

  it('sends over a server without TLS when TLS is not required', async () => {
    const mailer = createSmtpMailer({ url, from: 'noreply@example.test' });

    await expect(mailer.send(message)).resolves.toBeUndefined();
    mailer.close();
  });

  it('refuses a server without STARTTLS when TLS is required', async () => {
    const mailer = createSmtpMailer({ url, from: 'noreply@example.test', requireTls: true });

    const error = await failureOf(mailer);
    mailer.close();

    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error).toMatchObject({ code: 'ETLS', command: 'STARTTLS', responseCode: 502 });
  });

  it('keeps the address and the reply of the server out of the error of a rejected recipient', async () => {
    const mailer = createSmtpMailer({ url: rejectingUrl, from: 'noreply@example.test' });

    const error = await failureOf(mailer);
    mailer.close();

    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error).toMatchObject({
      name: 'SmtpDeliveryError',
      message: 'SMTP delivery failed: EENVELOPE, RCPT TO, 550',
      code: 'EENVELOPE',
      command: 'RCPT TO',
      responseCode: 550,
    });
    // What a logger or the queue keeps of an error: message, stack, every property and a cause.
    expect(inspect(error, { depth: null, showHidden: true })).not.toMatch(
      /example\.test|Recipient address rejected/,
    );
  });

  it('tunnels to the SMTP server through the egress proxy it gets (guide step 8.9)', async () => {
    const proxy = await startConnectRecorder();
    const mailer = createSmtpMailer({
      url: 'smtps://mail.example.test:465',
      from: 'noreply@example.test',
      proxy: proxy.url,
    });

    const error = await failureOf(mailer);
    mailer.close();
    await proxy.stop();

    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(proxy.tunnels).toEqual(['mail.example.test:465']);
  });

  it('names the system error behind a failed connection', async () => {
    const mailer = createSmtpMailer({ url: closedUrl, from: 'noreply@example.test' });

    const error = await failureOf(mailer);
    mailer.close();

    expect(error).toMatchObject({ code: 'ESOCKET', originalCode: 'ECONNREFUSED', command: 'CONN' });
  });
});
