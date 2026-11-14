import { randomUUID } from 'node:crypto';

import type { AdapterContext, PublishRequest, SocialAccountType } from '@smp/core';
import type { Platform } from '@smp/platform-rules';

// Test support for the real adapters: their fake platforms answer through the fetch the adapters
// take (LiveAdapterDeps.fetch), so the contract suite and the tests run the adapters unchanged
// against recorded answer forms. Not part of the package entry, so never bundled.

export const IMAGE_URL = 'https://storage.example/renditions/a.jpg';
/** The start of a JPEG; the fakes take any bytes. */
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A token whose platform answers every call with the status, as the contract suite asks. */
export const failingToken = (status: number, retryAfterSeconds?: number): string =>
  `fail-${String(status)}-${retryAfterSeconds === undefined ? '' : String(retryAfterSeconds)}`;

/** The answer for a failing token; undefined for any other. */
export function failureFor(request: Request, body: unknown = { message: 'failure' }): Response | undefined {
  const match = /^Bearer fail-(\d{3})-(\d*)$/.exec(request.headers.get('authorization') ?? '');
  if (!match) {
    return undefined;
  }
  const retryAfter = match[2] ?? '';
  return json(body, Number(match[1]), retryAfter.length > 0 ? { 'retry-after': retryAfter } : {});
}

/** The rendition behind IMAGE_URL; undefined for any other URL. */
export const imageFor = (url: URL): Response | undefined =>
  url.href === IMAGE_URL
    ? new Response(new Uint8Array(IMAGE_BYTES), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    : undefined;

/** A fetch that hands every request to the fake and records it. */
export function fakeFetch(handle: (request: Request, url: URL) => Promise<Response> | Response): {
  fetch: typeof fetch;
  requests: Request[];
} {
  const requests: Request[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return handle(request, new URL(request.url));
  };
  return { fetch: fetchFn, requests };
}

export const noSleep = (): Promise<void> => Promise.resolve();

export function contextFor(
  platform: Platform,
  account: { type: SocialAccountType; externalId: string; handle?: string | null },
  tokens: { access: string; refresh?: string | null },
  recorded: { costs?: { operation: string; units: number }[]; warnings?: string[] } = {},
): AdapterContext {
  return {
    account: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      platform,
      type: account.type,
      externalId: account.externalId,
      name: 'Nordlicht Haustechnik',
      handle: account.handle ?? null,
      settings: {},
    },
    credentials: {
      accessToken: () => Promise.resolve(tokens.access),
      refreshToken: () => Promise.resolve(tokens.refresh ?? null),
    },
    costs: {
      record: ({ operation, units = 1 }) => {
        recorded.costs?.push({ operation, units });
        return Promise.resolve();
      },
    },
    logger: {
      info: () => undefined,
      warn: (_fields, message) => {
        recorded.warnings?.push(message);
      },
    },
    signal: new AbortController().signal,
    dryRun: false,
    keepAlive: () => Promise.resolve(),
  };
}

export const requestWith = (text: string, media = 0, altText: string | null = null): PublishRequest => ({
  variantId: randomUUID(),
  text,
  firstComment: null,
  linkUrl: null,
  media: Array.from({ length: media }, () => ({
    url: IMAGE_URL,
    mimeType: 'image/jpeg',
    width: 1080,
    height: 1350,
    sizeBytes: IMAGE_BYTES.byteLength,
    altText,
  })),
  contentHash: `hash-${randomUUID()}`,
});

/** The form fields of a request body, multipart or urlencoded. */
export async function formOf(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  if (type.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(await request.text()));
  }
  const form = await request.formData();
  const fields: Record<string, string> = {};
  form.forEach((value, name) => {
    fields[name] = typeof value === 'string' ? value : `file:${value.type}`;
  });
  return fields;
}
