import type { ChannelConnectors, ConnectionMethod, OAuthConnector, SocialPlatformAdapter } from '@smp/core';
import type { Platform } from '@smp/platform-rules';

// Chooses the adapter of an account by platform and connection method (architecture 4.1). There
// is no silent switch between methods: an account of the X API never ends up in the browser
// adapter or the other way round. The browser adapter additionally needs its gate (kill switch,
// workspace flag, plan, risk acknowledgement; phase 6).

export class AdapterNotAvailableError extends Error {
  constructor(platform: Platform, method: ConnectionMethod) {
    super(`No adapter for ${platform} via ${method} is available.`);
    this.name = 'AdapterNotAvailableError';
  }
}

/** Decides whether the browser adapter may run for a workspace of an organization. */
export type BrowserGate = (scope: { organizationId: string; workspaceId: string }) => Promise<boolean>;

const DENY_BROWSER: BrowserGate = () => Promise.resolve(false);

export class AdapterRegistry implements ChannelConnectors {
  private readonly adapters = new Map<string, SocialPlatformAdapter>();

  constructor(
    adapters: readonly SocialPlatformAdapter[],
    private readonly browserGate: BrowserGate = DENY_BROWSER,
  ) {
    for (const adapter of adapters) {
      const key = `${adapter.platform}:${adapter.method}`;
      if (this.adapters.has(key)) {
        throw new Error(`Two adapters for ${adapter.platform} via ${adapter.method}.`);
      }
      this.adapters.set(key, adapter);
    }
  }

  /** The adapter of an account; throws AdapterNotAvailableError when there is none or its gate is closed. */
  async resolve(account: {
    platform: Platform;
    method: ConnectionMethod;
    organizationId: string;
    workspaceId: string;
  }): Promise<SocialPlatformAdapter> {
    const adapter = this.adapters.get(`${account.platform}:${account.method}`);
    const scope = { organizationId: account.organizationId, workspaceId: account.workspaceId };
    if (!adapter || (account.method === 'BROWSER' && !(await this.browserGate(scope)))) {
      throw new AdapterNotAvailableError(account.platform, account.method);
    }
    return adapter;
  }

  /** The adapter for a new connection, where the method is chosen by the configuration. */
  forConnecting(platform: Platform, method: ConnectionMethod): SocialPlatformAdapter {
    const adapter = this.adapters.get(`${platform}:${method}`);
    if (!adapter) {
      throw new AdapterNotAvailableError(platform, method);
    }
    return adapter;
  }

  /** The method new connections of the platform use; null when it cannot be connected. */
  methodFor(platform: Platform): ConnectionMethod | null {
    return this.methods().find((entry) => entry.platform === platform)?.method ?? null;
  }

  /** The OAuth connector of a platform and method; the browser method has none. */
  connector(platform: Platform, method: ConnectionMethod): OAuthConnector | null {
    return method === 'BROWSER' ? null : (this.adapters.get(`${platform}:${method}`)?.connector ?? null);
  }

  /** The platforms that can be connected, with the method each one uses. */
  methods(): { platform: Platform; method: ConnectionMethod }[] {
    return [...this.adapters.values()]
      .filter((adapter) => adapter.method !== 'BROWSER')
      .map((adapter) => ({ platform: adapter.platform, method: adapter.method }));
  }
}
