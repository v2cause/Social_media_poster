import { createServer, request as forward, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

import type { Logger } from '@smp/observability';
import type { EgressPolicy } from '@smp/x-browser';

// The egress proxy of the browser worker (guide step 6.2), and of API and worker in the
// deployment (guide step 8.9). They sit in internal networks; their only way out is this proxy,
// which applies its egress policy: a tunnel (CONNECT) to a host and port of the policy, or a
// plain http request to an http origin of it. Everything else gets 403 before any connection is made. The logs name hosts and ports,
// never paths or query strings, which carry the signatures of the media URLs.

const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
/** host:port of a tunnel; IPv6 literals are not part of the policy. */
const AUTHORITY = /^([a-z0-9.-]+):(\d{1,5})$/i;
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/** The headers without those of the hop to the proxy, also those the Connection header names. */
const endToEnd = (headers: IncomingHttpHeaders): IncomingHttpHeaders => {
  const named = (headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.includes(name) && !named.includes(name)),
  );
};

const refuse = (socket: Duplex, status: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
};

export function createEgressProxy(policy: EgressPolicy, logger: Pick<Logger, 'info' | 'warn'>): Server {
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/')) {
      // Not a proxy request: only the health check of the container.
      response.writeHead(url === '/health' ? 200 : 404, { 'content-type': 'text/plain' });
      response.end(url === '/health' ? 'ok' : '');
      return;
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const port = target.port === '' ? 80 : Number(target.port);
    if (target.protocol !== 'http:' || !policy.allowsPlain(target.hostname, port)) {
      logger.warn({ host: target.hostname, port, protocol: target.protocol }, 'egress.refused');
      response.writeHead(403).end();
      return;
    }
    const upstream = forward(
      {
        host: target.hostname,
        port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: endToEnd(request.headers),
        timeout: CONNECT_TIMEOUT_MS,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, endToEnd(answer.headers));
        answer.pipe(response);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(502).end();
      }
    });
    request.pipe(upstream);
  });

  server.on('connect', (request, socket: Duplex, head: Buffer) => {
    const match = AUTHORITY.exec(request.url ?? '');
    const host = match?.[1]?.toLowerCase() ?? '';
    const port = Number(match?.[2] ?? 0);
    if (!match || !policy.allowsTunnel(host, port)) {
      logger.warn({ host: match ? host : 'invalid', port }, 'egress.refused');
      refuse(socket, '403 Forbidden');
      return;
    }
    let open = false;
    const upstream = connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
    upstream.once('connect', () => {
      open = true;
      upstream.setTimeout(IDLE_TIMEOUT_MS);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = (): void => {
      if (!open && !socket.destroyed) {
        refuse(socket, '502 Bad Gateway');
      } else {
        socket.destroy();
      }
      upstream.destroy();
    };
    upstream.on('timeout', close);
    upstream.on('error', close);
    upstream.on('close', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });

  return server;
}
