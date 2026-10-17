import { execFile } from 'node:child_process';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { createLogger } from '@smp/observability';
import { egressPolicy } from '@smp/x-browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEgressProxy } from './proxy';

// Guide step 6.2: the browser worker leaves its network only through this proxy, which lets a
// tunnel or a plain request through to the hosts of the policy and refuses everything else
// before connecting. Upstream and proxy run on 127.0.0.1; nothing leaves the machine.

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

describe('egress proxy', () => {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  let strayConnections = 0;
  const upstream = createServer((incoming, response) => {
    seen.push({ path: incoming.url ?? '', headers: incoming.headers });
    response.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
  });
  // A host outside the policy: it must never see a connection.
  const stray = createServer((_incoming, response) => response.end('stray'));
  stray.on('connection', () => {
    strayConnections += 1;
  });
  const lines: string[] = [];
  let allowed = 0;
  let blocked = 0;
  let proxyPort = 0;
  let proxy: Server | undefined;

  beforeAll(async () => {
    allowed = await listen(upstream);
    blocked = await listen(stray);
    proxy = createEgressProxy(
      egressPolicy(['x.com', `http://127.0.0.1:${String(allowed)}`]),
      createLogger({
        service: 'egress-proxy',
        environment: 'test',
        destination: { write: (line: string) => lines.push(line) },
      }),
    );
    proxyPort = await listen(proxy);
  });

  afterAll(async () => {
    for (const server of [proxy, upstream, stray]) {
      server?.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
    }
  });

  const viaProxy = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: proxyPort, path, headers }, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      });
      outgoing.on('error', reject);
      outgoing.end();
    });

  const tunnel = (authority: string) =>
    new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
      outgoing.on('connect', (response, socket) => {
        resolve({ status: response.statusCode ?? 0, socket });
      });
      outgoing.on('error', reject);
      outgoing.end();
    });

  it('answers the health check of the container', async () => {
    await expect(viaProxy('/health')).resolves.toEqual({ status: 200, body: 'ok' });
  });

  it('forwards a plain request to an origin of the policy without the headers of the proxy hop', async () => {
    const answer = await viaProxy(`http://127.0.0.1:${String(allowed)}/smp-media/a.jpg?X-Amz-Signature=abc`, {
      'proxy-authorization': 'Basic c2VjcmV0',
      'x-request-id': 'r-1',
    });
    expect(answer).toEqual({ status: 200, body: 'hello' });
    expect(seen.at(-1)?.path).toBe('/smp-media/a.jpg?X-Amz-Signature=abc');
    expect(seen.at(-1)?.headers['proxy-authorization']).toBeUndefined();
    expect(seen.at(-1)?.headers['x-request-id']).toBe('r-1');
  });

  it('opens a tunnel to a host and port of the policy', async () => {
    const { status, socket } = await tunnel(`127.0.0.1:${String(allowed)}`);
    expect(status).toBe(200);
    const reply = await new Promise<string>((resolve) => {
      let text = '';
      socket.on('data', (chunk: Buffer) => (text += chunk.toString()));
      socket.on('end', () => {
        resolve(text);
      });
      socket.write(`GET /through-the-tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    expect(reply).toContain('hello');
    expect(seen.at(-1)?.path).toBe('/through-the-tunnel');
  });

  it('refuses every other host and port before connecting, and logs no path', async () => {
    await expect(
      viaProxy(`http://127.0.0.1:${String(blocked)}/secret?X-Amz-Signature=abc`),
    ).resolves.toMatchObject({
      status: 403,
    });
    await expect(viaProxy('https://x.com/home')).resolves.toMatchObject({ status: 403 });
    for (const authority of [
      `127.0.0.1:${String(blocked)}`,
      'x.com:80',
      'evil.example:443',
      'no-port-given',
    ]) {
      const { status, socket } = await tunnel(authority);
      socket.destroy();
      expect(status, authority).toBe(403);
    }
    expect(strayConnections).toBe(0);
    const log = lines.join('');
    expect(log).toContain('"host":"evil.example"');
    expect(log).not.toContain('X-Amz-Signature');
    expect(log).not.toContain('/secret');
  });

  it('carries the media downloads of Node through it, as the browser worker makes them', async () => {
    const script = `Promise.allSettled([fetch(process.argv[1]).then((r) => r.text()), fetch(process.argv[2]).then((r) => r.text())]).then((results) => console.log(JSON.stringify(results.map((result) => result.status === 'fulfilled' ? result.value : 'failed'))))`;
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          '-e',
          script,
          `http://127.0.0.1:${String(allowed)}/a.jpg`,
          `http://127.0.0.1:${String(blocked)}/b.jpg`,
        ],
        {
          timeout: 20_000,
          env: {
            PATH: process.env['PATH'] ?? '',
            NODE_USE_ENV_PROXY: '1',
            HTTP_PROXY: `http://127.0.0.1:${String(proxyPort)}`,
            HTTPS_PROXY: `http://127.0.0.1:${String(proxyPort)}`,
            NO_PROXY: '',
          },
        },
        (error, stdout) => {
          if (error) {
            reject(new Error(`the fetch script failed: ${error.message}`));
          } else {
            resolve(stdout);
          }
        },
      );
    });
    expect(JSON.parse(output) as string[]).toEqual(['hello', 'failed']);
    expect(strayConnections).toBe(0);
  });
});
