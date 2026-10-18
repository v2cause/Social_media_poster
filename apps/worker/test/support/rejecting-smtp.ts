import { createServer, type Socket } from 'node:net';

// An SMTP server that rejects every recipient the way real servers do, with the address in the
// reply (guide step 8.4). A failed job must not keep it.

export interface RejectingSmtp {
  url: string;
  close(): Promise<void>;
}

export async function startRejectingSmtp(): Promise<RejectingSmtp> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\r\n')) {
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO') {
          socket.write('250-test\r\n250 SIZE 10240000\r\n');
        } else if (command === 'RCPT') {
          socket.write(`550 5.1.1 ${line.slice(line.indexOf('<'))}: Recipient address rejected\r\n`);
        } else if (command === 'QUIT') {
          socket.end('221 bye\r\n');
        } else if (line.length > 0) {
          socket.write('250 ok\r\n');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `smtp://127.0.0.1:${typeof address === 'object' && address ? String(address.port) : '0'}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}
