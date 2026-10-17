import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { egressPolicy } from '@smp/x-browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_MEDIA_BYTES, mediaFetcher, mediaFileName, MediaUnavailableError } from './media';

// Guide step 6.2: the media come only from hosts of the egress policy, without redirects and
// up to 16 MB, before the browser starts.

describe('mediaFetcher', () => {
  let server: Server | undefined;
  let origin = '';
  const requests: string[] = [];

  beforeAll(async () => {
    const listening = createServer((request, response) => {
      requests.push(request.url ?? '');
      switch (new URL(request.url ?? '/', 'http://localhost').pathname) {
        case '/image.jpg':
          response.writeHead(200, { 'content-type': 'image/jpeg' }).end('jpeg-bytes');
          return;
        case '/moved.jpg':
          response.writeHead(302, { location: 'https://evil.example/image.jpg' }).end();
          return;
        case '/declared-large.jpg':
          response.writeHead(200, { 'content-length': String(MAX_MEDIA_BYTES + 1) }).end();
          return;
        case '/streamed-large.jpg': {
          response.writeHead(200, { 'content-type': 'image/jpeg' });
          const chunk = Buffer.alloc(1024 * 1024);
          for (let index = 0; index <= MAX_MEDIA_BYTES / chunk.length; index += 1) {
            response.write(chunk);
          }
          response.end();
          return;
        }
        default:
          response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
    server = listening;
    origin = `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
  });

  const fetchMedia = () => mediaFetcher(egressPolicy([origin]));
  const reasonOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'loaded',
      (error: unknown) => (error instanceof MediaUnavailableError ? error.reason : 'other'),
    );

  it('loads the bytes of an allowed origin', async () => {
    await expect(fetchMedia()(`${origin}/image.jpg?X-Amz-Signature=abc`)).resolves.toEqual(
      Buffer.from('jpeg-bytes'),
    );
  });

  it('refuses other hosts without asking them, and redirects', async () => {
    const before = requests.length;
    await expect(reasonOf(fetchMedia()('https://evil.example/image.jpg'))).resolves.toBe('refused_host');
    await expect(reasonOf(fetchMedia()('file:///etc/passwd'))).resolves.toBe('refused_host');
    expect(requests).toHaveLength(before);
    await expect(reasonOf(fetchMedia()(`${origin}/moved.jpg`))).resolves.toBe('network');
  });

  it('stops at 16 MB, declared or streamed, and at an error status', async () => {
    await expect(reasonOf(fetchMedia()(`${origin}/declared-large.jpg`))).resolves.toBe('too_large');
    await expect(reasonOf(fetchMedia()(`${origin}/streamed-large.jpg`))).resolves.toBe('too_large');
    await expect(reasonOf(fetchMedia()(`${origin}/missing.jpg`))).resolves.toBe('status');
  });

  it('names the files for the composer', () => {
    expect(mediaFileName(0, 'image/jpeg')).toBe('image-1.jpg');
    expect(mediaFileName(3, 'image/webp')).toBe('image-4.webp');
  });
});
