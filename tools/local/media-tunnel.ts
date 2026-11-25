import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';

// Instagram fetches every image itself from a public URL (ADR 0049); the storage of the single-user
// mode listens on 127.0.0.1 only. pnpm local therefore opens a Cloudflare quick tunnel, but never
// to the storage itself: the local storage runs with the well-known keys of the repository and
// admin rights. The tunnel ends at this proxy, which passes on nothing but presigned GET and HEAD
// requests for the Instagram renditions and asks the storage under its own host, so that the
// signature made for that host stays valid.

/** The key of an Instagram rendition, path-style: /bucket/ws/{ws}/assets/{asset}/renditions/... */
const RENDITION_PATH =
  /^\/[a-z0-9][a-z0-9.-]{1,62}\/ws\/[0-9a-f-]{36}\/assets\/[0-9a-f-]{36}\/renditions\/instagram_feed-[A-Za-z0-9-]{1,40}\.jpg$/;

/** Whether the proxy passes the request on to the storage. Pure, for the tests. */
export function isAllowedMediaRequest(method: string | undefined, rawUrl: string | undefined): boolean {
  if ((method !== 'GET' && method !== 'HEAD') || !rawUrl) {
    return false;
  }
  const url = new URL(rawUrl, 'http://proxy.invalid');
  return RENDITION_PATH.test(url.pathname) && url.searchParams.has('X-Amz-Signature');
}

/** Starts the proxy on a free port of 127.0.0.1 in front of the storage at storageUrl. */
export function startMediaProxy(storageUrl: string): Promise<{ server: Server; port: number }> {
  const storage = new URL(storageUrl);
  const server = createServer((incoming, outgoing) => {
    if (!isAllowedMediaRequest(incoming.method, incoming.url)) {
      outgoing.writeHead(404).end();
      return;
    }
    const forwarded = request(
      {
        protocol: storage.protocol,
        hostname: storage.hostname,
        port: storage.port,
        method: incoming.method,
        path: incoming.url,
        // Only the host: no cookies, no authorization and nothing else of the caller goes on.
        headers: { host: storage.host },
      },
      (answer) => {
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'content-length', 'etag', 'last-modified']) {
          const value = answer.headers[name];
          if (typeof value === 'string') {
            headers[name] = value;
          }
        }
        outgoing.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(outgoing);
      },
    );
    forwarded.on('error', () => {
      outgoing.writeHead(502).end();
    });
    forwarded.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_WAIT_MS = 60_000;

/**
 * Opens a Cloudflare quick tunnel (no account needed) to the proxy and resolves with its public
 * URL; null when cloudflared is missing or reports no URL in time.
 */
export function startQuickTunnel(
  binary: string,
  port: number,
  shell: boolean,
): Promise<{ url: string; process: ChildProcess } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${String(port)}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    });
    const finish = (value: { url: string; process: ChildProcess } | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (value === null) {
          child.kill();
        }
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      finish(null);
    }, TUNNEL_WAIT_MS);
    const look = (chunk: Buffer): void => {
      const url = TUNNEL_URL.exec(chunk.toString('utf8'))?.[0];
      if (url) {
        finish({ url, process: child });
      }
    };
    child.stdout.on('data', look);
    child.stderr.on('data', look);
    child.on('error', () => {
      finish(null);
    });
    child.on('exit', () => {
      finish(null);
    });
  });
}
