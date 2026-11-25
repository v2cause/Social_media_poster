import { createHmac } from 'node:crypto';

import type { z } from 'zod';

import type { HttpBody, HttpMethod, PlatformHttpClient } from '../http/platform-http-client';
import { META_GRAPH_HOST, type ResolvedMetaAppConfig } from './graph-config';
import { metaErrorMapper } from './graph-errors';

// A thin layer over the shared HTTP client for the Graph API (graph.facebook.com/vNN.0):
// - The access token goes in the Authorization header ("Authorization: Bearer <ACCESS_TOKEN>", as
//   in the examples of the Content Publishing guide, checked 2026-11-25:
//   https://developers.facebook.com/documentation/instagram-platform/content-publishing), so it
//   stays out of URLs. The client never logs query strings anyway (Meta also accepts tokens there).
// - Every call with a token carries appsecret_proof, the HMAC-SHA256 of the token keyed with the
//   app secret, so the calls keep working when "Require App Secret" is switched on. Checked
//   2026-11-25: https://developers.facebook.com/docs/graph-api/securing-requests/
// - Errors go through the Graph error mapping first (graph-errors.ts).

export interface GraphCall<T> {
  /** For logs and spans, for example facebook.feed.create. */
  operation: string;
  method: HttpMethod;
  /** The path after the version, for example /me/accounts. */
  path: string;
  /** A user or Page access token; none for the code exchange, which sends the app secret. */
  token?: string;
  query?: Readonly<Record<string, string>>;
  form?: Readonly<Record<string, string>>;
  body?: HttpBody;
  schema?: z.ZodType<T>;
  /** Whether the call may run twice; defaults to true for GET and DELETE. */
  idempotent?: boolean;
  /** The SocialAccount the call is for, for the rate limiter. */
  accountId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class GraphApi {
  constructor(
    private readonly http: PlatformHttpClient,
    private readonly app: ResolvedMetaAppConfig,
  ) {}

  get appId(): string {
    return this.app.appId;
  }

  get graphVersion(): string {
    return this.app.graphVersion;
  }

  /** The URL of a Graph path with the pinned version. */
  url(path: string, query: Readonly<Record<string, string>> = {}): URL {
    const url = new URL(`${META_GRAPH_HOST}/${this.app.graphVersion}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  /** The app secret proof of a token. */
  proofOf(token: string): string {
    return createHmac('sha256', this.app.appSecret).update(token).digest('hex');
  }

  /** The query of the code exchange and token calls, which carry the app credentials. */
  appCredentials(): Record<string, string> {
    return { client_id: this.app.appId, client_secret: this.app.appSecret };
  }

  async call<T>(call: GraphCall<T>): Promise<T> {
    const url = this.url(call.path, call.query);
    const headers: Record<string, string> = {};
    if (call.token !== undefined) {
      url.searchParams.set('appsecret_proof', this.proofOf(call.token));
      headers.authorization = `Bearer ${call.token}`;
    }
    const body: HttpBody | undefined = call.body ?? (call.form ? { form: call.form } : undefined);
    const response = await this.http.request<T>({
      operation: call.operation,
      method: call.method,
      url: url.toString(),
      headers,
      body,
      schema: call.schema,
      idempotent: call.idempotent,
      signal: call.signal,
      timeoutMs: call.timeoutMs,
      rateLimit: call.accountId === undefined ? undefined : { accountId: call.accountId },
      mapError: metaErrorMapper(call.operation),
    });
    return response.data;
  }
}
