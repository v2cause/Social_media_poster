import { createServer, type Server } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSmtpMailer } from './smtp-mailer';

// Guide step 8.4: production never sends a mail in plain text. A server that offers no STARTTLS,
// like Mailpit locally, takes the mail only when TLS is not required.

/** An SMTP server without STARTTLS that accepts every mail. */
function plainSmtpServer(): Server {
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

describe('createSmtpMailer', () => {
  const server = plainSmtpServer();
  let url = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    url = `smtp://127.0.0.1:${typeof address === 'object' && address ? String(address.port) : '0'}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const message = { to: 'ada@example.test', subject: 'Hallo', html: '<p>Hallo</p>', text: 'Hallo' };

  it('sends over a server without TLS when TLS is not required', async () => {
    const mailer = createSmtpMailer({ url, from: 'noreply@example.test' });

    await expect(mailer.send(message)).resolves.toBeUndefined();
    mailer.close();
  });

  it('refuses a server without STARTTLS when TLS is required', async () => {
    const mailer = createSmtpMailer({ url, from: 'noreply@example.test', requireTls: true });

    await expect(mailer.send(message)).rejects.toThrow(/STARTTLS/i);
    mailer.close();
  });
});
