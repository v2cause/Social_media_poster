import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { isPlatformError, PlatformError, type AdapterLogger } from '@smp/core';
import type { Platform } from '@smp/platform-rules';
import type { z } from 'zod';

import type { PlatformRateLimiter, RateLimitScope } from '../rate-limit/platform-rate-limiter';
import { platformErrorOf } from './errors';

// The HTTP client of all platform adapters (architecture 4.1): the fetch of Node (undici) with a
// timeout of 30 s and no retries of its own, because the job retries. Answers are checked with
// zod before anything uses them, and every failure becomes a PlatformError:
// - no connection (refused, unknown host): TRANSIENT, nothing was sent;
// - a timeout or broken answer after sending: TRANSIENT when the call can be repeated,
//   OUTCOME_UNKNOWN for a create call, whose post may exist now.
// Logs and spans carry method, host, path, status and duration, never the query string (Meta
// passes tokens there), headers or bodies.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HttpBody =
  { json: unknown } | { form: Readonly<Record<string, string>> } | { bytes: Uint8Array; contentType: string };

export interface ErrorResponse {
  status: number;
  headers: Headers;
  /** The answer as JSON where it is JSON, else its text. */
  body: unknown;
}

export interface PlatformRequest<T> {
  /** For logs and spans, for example linkedin.posts.create. */
  operation: string;
  method: HttpMethod;
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: HttpBody;
  /** Checks the JSON answer; without it the answer is not read. */
  schema?: z.ZodType<T>;
  /** Whether the call may run twice; defaults to true for GET, PUT and DELETE. */
  idempotent?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Throttles the call per app and account before it goes out. */
  rateLimit?: Omit<RateLimitScope, 'platform'>;
  /** Platform-specific errors of a 4xx or 5xx answer, before the generic mapping. */
  mapError?: (response: ErrorResponse) => PlatformError | undefined;
}

export interface PlatformResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface PlatformHttpClientOptions {
  platform: Platform;
  logger?: AdapterLogger;
  limiter?: PlatformRateLimiter;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
}

// Errors of the connection itself: the request never reached the platform. A failed TLS handshake
// belongs here too, an expired or untrusted certificate for example: the request goes out only
// after it (ASVS 16.3.4).
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const tracer = trace.getTracer('@smp/platform-adapters');

// The code of a failed connection as Node names it (ECONNRESET, CERT_HAS_EXPIRED); nothing else of
// the cause reaches the message.
const causeCode = (error: unknown): string | undefined => {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(code) ? code : undefined;
};

function encode(body: HttpBody | undefined): { body?: BodyInit; contentType?: string } {
  if (!body) {
    return {};
  }
  if ('json' in body) {
    return { body: JSON.stringify(body.json), contentType: 'application/json' };
  }
  if ('form' in body) {
    return {
      body: new URLSearchParams(body.form).toString(),
      contentType: 'application/x-www-form-urlencoded',
    };
  }
  return { body: new Uint8Array(body.bytes), contentType: body.contentType };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class PlatformHttpClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: PlatformHttpClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get platform(): Platform {
    return this.options.platform;
  }

  request<T>(request: PlatformRequest<T>): Promise<PlatformResponse<T>> {
    const url = new URL(request.url);
    const idempotent = request.idempotent ?? ['GET', 'PUT', 'DELETE'].includes(request.method);
    return tracer.startActiveSpan(
      `${this.options.platform} ${request.operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': request.method,
          'server.address': url.host,
          'url.path': url.pathname,
          'smp.platform': this.options.platform,
          'smp.operation': request.operation,
        },
      },
      async (span) => {
        const started = performance.now();
        let status: number | undefined;
        try {
          const response = await this.send(request, url, idempotent);
          status = response.status;
          span.setAttribute('http.response.status_code', response.status);
          return response;
        } catch (error) {
          const failure = isPlatformError(error)
            ? error
            : this.unexpected(error, idempotent, request.operation);
          status ??= failure.status;
          span.setStatus({ code: SpanStatusCode.ERROR, message: failure.code });
          span.setAttribute('smp.platform_error', failure.code);
          throw failure;
        } finally {
          this.options.logger?.info(
            {
              platform: this.options.platform,
              operation: request.operation,
              method: request.method,
              host: url.host,
              path: url.pathname,
              status: status ?? null,
              durationMs: Math.round(performance.now() - started),
            },
            'platform.http',
          );
          span.end();
        }
      },
    );
  }

  private async send<T>(
    request: PlatformRequest<T>,
    url: URL,
    idempotent: boolean,
  ): Promise<PlatformResponse<T>> {
    const scope: RateLimitScope = { platform: this.options.platform, ...request.rateLimit };
    if (request.rateLimit) {
      await this.options.limiter?.acquire(scope);
    }
    const encoded = encode(request.body);
    const timeout = AbortSignal.timeout(request.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: request.method,
        headers: {
          accept: 'application/json',
          ...(encoded.contentType ? { 'content-type': encoded.contentType } : {}),
          ...request.headers,
        },
        body: encoded.body,
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch (error) {
      throw this.unexpected(error, idempotent, request.operation);
    }

    if (!response.ok) {
      const errorResponse: ErrorResponse = {
        status: response.status,
        headers: response.headers,
        body: await readBody(response).catch(() => null),
      };
      const failure = request.mapError?.(errorResponse) ?? platformErrorOf(response, request.operation);
      if (failure.code === 'RATE_LIMITED' && request.rateLimit) {
        await this.options.limiter?.penalize(scope, failure.retryAfterMs ?? 0);
      }
      throw failure;
    }

    if (!request.schema) {
      await response.body?.cancel();
      return { status: response.status, headers: response.headers, data: undefined as T };
    }
    const body = await readBody(response).catch(() => undefined);
    const parsed = request.schema.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError(
        idempotent ? 'TRANSIENT' : 'OUTCOME_UNKNOWN',
        `${request.operation} answered in an unexpected format`,
        { status: response.status },
      );
    }
    return { status: response.status, headers: response.headers, data: parsed.data };
  }

  /** A failure without an answer of the platform; its message names the code of the cause. */
  private unexpected(error: unknown, idempotent: boolean, operation: string): PlatformError {
    const code = causeCode(error);
    if (code !== undefined && NOT_SENT.has(code)) {
      return new PlatformError('TRANSIENT', `${operation} could not connect (${code})`);
    }
    const name = error instanceof Error ? error.name : 'unknown error';
    const reason = code === undefined ? name : `${name}, ${code}`;
    return idempotent
      ? new PlatformError('TRANSIENT', `${operation} failed without an answer (${reason})`)
      : new PlatformError('OUTCOME_UNKNOWN', `${operation} sent, but the answer is missing (${reason})`);
  }
}
