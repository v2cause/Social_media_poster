import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for the range API of Have I Been Pwned (guide step 8.4): it knows one breached
// password, and fails for another one, so that the tests see both answers without the internet.

export const BREACHED_PASSWORD = 'this one leaked in a breach';
/** Its prefix gets a 503, as when the service is down. */
export const UNCHECKABLE_PASSWORD = 'the breach check is down today';

const sha1 = (text: string): string => createHash('sha1').update(text, 'utf8').digest('hex').toUpperCase();

export interface StartedPwnedPasswords {
  url: string;
  /** The prefixes asked for so far. */
  prefixes: string[];
  stop: () => Promise<void>;
}

export async function startPwnedPasswords(): Promise<StartedPwnedPasswords> {
  const breached = sha1(BREACHED_PASSWORD);
  const down = sha1(UNCHECKABLE_PASSWORD).slice(0, 5);
  const prefixes: string[] = [];
  const server: Server = createServer((request, response) => {
    const prefix = /^\/range\/([0-9A-F]{5})$/.exec(request.url ?? '')?.[1];
    if (!prefix) {
      response.writeHead(404).end();
      return;
    }
    prefixes.push(prefix);
    if (prefix === down) {
      response.writeHead(503).end('Service Unavailable');
      return;
    }
    // Padding as with Add-Padding, and the breached suffix where its prefix matches.
    const lines = ['0000000000000000000000000000000000A:0'];
    if (breached.startsWith(prefix)) {
      lines.push(`${breached.slice(5)}:3861493`);
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end(lines.join('\r\n'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    prefixes,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
