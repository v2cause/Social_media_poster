import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { startConnectRecorder, type ConnectRecorder } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { S3Storage, type S3StorageConfig } from './s3-storage';

// Guide step 8.9: a storage outside the network of the deployment is reached through the egress
// proxy, one inside it, which NO_PROXY names, directly. The SDK of S3 ignores HTTPS_PROXY with
// agents of its own, so it gets the proxy settings.

const settings = (endpoint: string, proxyEnv: S3StorageConfig['proxyEnv']): S3StorageConfig => ({
  endpoint,
  region: 'eu-central-1',
  bucket: 'smp-media',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: true,
  proxyEnv,
});

describe('S3Storage behind the egress proxy', () => {
  let proxy: ConnectRecorder | undefined;
  const recorder = (): ConnectRecorder => {
    if (!proxy) {
      throw new Error('The proxy did not start.');
    }
    return proxy;
  };

  beforeAll(async () => {
    proxy = await startConnectRecorder();
  });

  afterAll(async () => {
    await proxy?.stop();
  });

  it('opens its connections to a storage outside the network through the proxy', async () => {
    const storage = new S3Storage(settings('https://storage.example.test', { HTTPS_PROXY: recorder().url }));

    await expect(storage.head('ws/missing')).rejects.toThrow();
    expect(recorder().tunnels).toContain('storage.example.test:443');
    storage.destroy();
  });

  it('reaches a storage that NO_PROXY names directly', async () => {
    let direct = 0;
    const storageServer = createServer((socket) => {
      direct += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => storageServer.listen(0, '127.0.0.1', resolve));
    const { port } = storageServer.address() as AddressInfo;
    const before = recorder().tunnels.length;
    const storage = new S3Storage(
      settings(`http://127.0.0.1:${String(port)}`, {
        HTTP_PROXY: recorder().url,
        HTTPS_PROXY: recorder().url,
        NO_PROXY: '127.0.0.1',
      }),
    );

    await expect(storage.head('ws/missing')).rejects.toThrow();
    expect(direct).toBeGreaterThan(0);
    expect(recorder().tunnels).toHaveLength(before);
    storage.destroy();
    await new Promise((resolve) => storageServer.close(resolve));
  });
});
