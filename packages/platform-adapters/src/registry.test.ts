import { systemClock } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { InMemoryMockPlatformStore } from './mock/mock-platform-store';
import { MockPlatformAdapter } from './mock/mock-platform-adapter';
import { AdapterNotAvailableError, AdapterRegistry } from './registry';
import { XBrowserRemoteAdapter } from './x-browser/remote-adapter';

// The registry picks the adapter by platform and method, never another method (architecture 4.1).

const mock = (platform: 'X' | 'LINKEDIN') =>
  new MockPlatformAdapter(platform, {
    store: new InMemoryMockPlatformStore(),
    clock: systemClock,
    authorizeUrl: 'http://localhost/a',
  });

describe('AdapterRegistry', () => {
  it('resolves the adapter of an account and refuses other methods', async () => {
    const registry = new AdapterRegistry([mock('X'), mock('LINKEDIN')]);

    await expect(
      registry.resolve({ platform: 'X', method: 'MOCK', organizationId: 'o', workspaceId: 'w' }),
    ).resolves.toHaveProperty('platform', 'X');
    await expect(
      registry.resolve({ platform: 'X', method: 'API', organizationId: 'o', workspaceId: 'w' }),
    ).rejects.toBeInstanceOf(AdapterNotAvailableError);
    await expect(
      registry.resolve({ platform: 'X', method: 'BROWSER', organizationId: 'o', workspaceId: 'w' }),
    ).rejects.toBeInstanceOf(AdapterNotAvailableError);
    expect(registry.methods()).toEqual([
      { platform: 'X', method: 'MOCK' },
      { platform: 'LINKEDIN', method: 'MOCK' },
    ]);
  });

  it('hands out the OAuth connectors for the flow of guide step 4.5', () => {
    const x = mock('X');
    const registry = new AdapterRegistry([x]);

    expect(registry.methodFor('X')).toBe('MOCK');
    expect(registry.methodFor('LINKEDIN')).toBeNull();
    expect(registry.connector('X', 'MOCK')).toBe(x.connector);
    expect(registry.connector('X', 'API')).toBeNull();
    expect(registry.connector('X', 'BROWSER')).toBeNull();
  });

  it('hands out the browser adapter of X only while its gate is open for the organization and workspace', async () => {
    const browser = new XBrowserRemoteAdapter({
      bus: { send: () => Promise.reject(new Error('not expected')) },
      clock: systemClock,
    });
    const asked: { organizationId: string; workspaceId: string }[] = [];
    const open = new Set(['o:w']);
    const registry = new AdapterRegistry([mock('X'), browser], (scope) => {
      asked.push(scope);
      return Promise.resolve(open.has(`${scope.organizationId}:${scope.workspaceId}`));
    });

    await expect(
      registry.resolve({ platform: 'X', method: 'BROWSER', organizationId: 'o', workspaceId: 'w' }),
    ).resolves.toBe(browser);
    await expect(
      registry.resolve({ platform: 'X', method: 'BROWSER', organizationId: 'o', workspaceId: 'other' }),
    ).rejects.toBeInstanceOf(AdapterNotAvailableError);
    expect(asked).toEqual([
      { organizationId: 'o', workspaceId: 'w' },
      { organizationId: 'o', workspaceId: 'other' },
    ]);
    // The mock method of X never asks the gate, and the browser offers no OAuth to connect.
    await registry.resolve({ platform: 'X', method: 'MOCK', organizationId: 'o', workspaceId: 'other' });
    expect(asked).toHaveLength(2);
    expect(registry.connector('X', 'BROWSER')).toBeNull();
    expect(registry.methods()).toEqual([{ platform: 'X', method: 'MOCK' }]);
  });

  it('refuses two adapters for the same platform and method', () => {
    expect(() => new AdapterRegistry([mock('X'), mock('X')])).toThrow(/Two adapters/);
  });
});
