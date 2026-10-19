import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for the egress proxy of the deployment (guide step 8.9): it records the tunnels
// (CONNECT) a client asks for and refuses each of them, so that no test reaches the internet.

export interface ConnectRecorder {
  /** http://127.0.0.1:<port>, for HTTPS_PROXY or the proxy option of a client. */
  url: string;
  /** host:port of every tunnel the clients asked for, in order. */
  tunnels: string[];
  stop: () => Promise<void>;
}

export async function startConnectRecorder(): Promise<ConnectRecorder> {
  const tunnels: string[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(403).end();
  });
  server.on('connect', (request, socket) => {
    tunnels.push(request.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    tunnels,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
