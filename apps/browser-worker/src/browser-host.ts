import type { EgressPolicy } from '@smp/x-browser';
import type { Browser, BrowserContext, Page } from 'playwright';

// The browser of the container (guide step 6.2): one Chromium per process, a new context per
// task with the storage state of its account, a desktop viewport and the language of the
// account; every action waits at most 30 seconds. Requests outside the egress policy end in the
// context, before the egress proxy of the network would refuse them; WebSockets are left to the
// proxy, because routing them puts a script into the page. No stealth plugins, no changed
// fingerprint and nothing injected into the pages: Chromium shows itself as it is.

/** The storage state of Playwright: the cookies and the local storage per origin. */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export const VIEWPORT = { width: 1280, height: 800 } as const;
export const ACTION_TIMEOUT_MS = 30_000;
const LOCALES = { de: 'de-DE', en: 'en-US' } as const;
/** Enough refused hosts to complete the egress list, without flooding the logs. */
const MAX_REFUSED_HOSTS = 20;

export interface TaskOptions {
  storageState: StorageState | null;
  locale: keyof typeof LOCALES;
}

export interface TaskEnd<T> {
  result: { ok: true; value: T } | { ok: false; error: unknown };
  /** The storage state the context ended with; null when the context could not give it. */
  storageState: StorageState | null;
  /** The hosts the context refused, for the logs. */
  refusedHosts: string[];
}

export interface BrowserHostOptions {
  launch: () => Promise<Browser>;
  policy: EgressPolicy;
  actionTimeoutMs?: number;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
};

export class BrowserHost {
  private browser: Promise<Browser> | null = null;
  private closed = false;

  constructor(private readonly options: BrowserHostOptions) {}

  /**
   * Runs the work on a page of a new context and closes the context afterwards. A failure of the
   * work is part of the result; onFailure sees the page before it closes.
   */
  async run<T>(
    task: TaskOptions,
    work: (page: Page) => Promise<T>,
    onFailure?: (page: Page, error: unknown) => Promise<void>,
  ): Promise<TaskEnd<T>> {
    const browser = await this.browserOf();
    const context = await browser.newContext({
      ...(task.storageState ? { storageState: task.storageState } : {}),
      locale: LOCALES[task.locale],
      viewport: VIEWPORT,
      acceptDownloads: false,
      // Requests of a service worker would pass the route of the context.
      serviceWorkers: 'block',
    });
    const refused = new Set<string>();
    try {
      const timeout = this.options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
      context.setDefaultTimeout(timeout);
      context.setDefaultNavigationTimeout(timeout);
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (this.options.policy.allowsUrl(url)) {
          return route.continue();
        }
        if (refused.size < MAX_REFUSED_HOSTS) {
          refused.add(hostOf(url));
        }
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      let result: TaskEnd<T>['result'];
      try {
        result = { ok: true, value: await work(page) };
      } catch (error) {
        result = { ok: false, error };
        await onFailure?.(page, error).catch(() => undefined);
      }
      const storageState = await context.storageState().catch(() => null);
      return { result, storageState, refusedHosts: [...refused] };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /** Closes the browser; the host takes no task afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    await browser?.then((running) => running.close()).catch(() => undefined);
  }

  /** Starts Chromium on the first task and again after it went away. */
  private browserOf(): Promise<Browser> {
    if (this.closed) {
      return Promise.reject(new Error('The browser host is closed.'));
    }
    if (!this.browser) {
      const launched = this.options.launch().then((browser) => {
        browser.on('disconnected', () => {
          if (this.browser === launched) {
            this.browser = null;
          }
        });
        return browser;
      });
      launched.catch(() => {
        if (this.browser === launched) {
          this.browser = null;
        }
      });
      this.browser = launched;
    }
    return this.browser;
  }
}
