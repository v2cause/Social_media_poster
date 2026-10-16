import { systemClock } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { InMemoryMockPlatformStore } from './mock/mock-platform-store';
import { MockPlatformAdapter } from './mock/mock-platform-adapter';
import { AdapterNotAvailableError, AdapterRegistry } from './registry';

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
      registry.resolve({ platform: 'X', method: 'MOCK', workspaceId: 'w' }),
    ).resolves.toHaveProperty('platform', 'X');
    await expect(registry.resolve({ platform: 'X', method: 'API', workspaceId: 'w' })).rejects.toBeInstanceOf(
      AdapterNotAvailableError,
    );
    await expect(
      registry.resolve({ platform: 'X', method: 'BROWSER', workspaceId: 'w' }),
    ).rejects.toBeInstanceOf(AdapterNotAvailableError);
    expect(registry.methods()).toEqual([
      { platform: 'X', method: 'MOCK' },
      { platform: 'LINKEDIN', method: 'MOCK' },
    ]);
  });

  it('refuses two adapters for the same platform and method', () => {
    expect(() => new AdapterRegistry([mock('X'), mock('X')])).toThrow(/Two adapters/);
  });
});
