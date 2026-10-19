import { Agent as HttpAgent, request as httpRequest, type ProxyEnv } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

import * as Sentry from '@sentry/node';
import type { ErrorEvent, NodeOptions } from '@sentry/node';

export interface ErrorReportingOptions {
  dsn?: string;
  environment: string;
  /** The egress proxy of the deployment (guide step 8.9), see proxyEnvOf. */
  proxyEnv?: ProxyEnv | undefined;
}

// Cookies and credentials never leave the process, even inside error reports.
const SCRUBBED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);

export function scrubRequestHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !SCRUBBED_HEADERS.has(name.toLowerCase())),
  );
}

/**
 * Removes what an error report must not carry: credential headers, cookies, the request body
 * (passwords, post drafts) and the query string (OAuth codes and state). Mutates and returns the
 * event, as Sentry's beforeSend expects.
 */
export function scrubEvent<T extends ErrorEvent>(event: T): T {
  const request = event.request;
  if (request) {
    if (request.headers) {
      request.headers = scrubRequestHeaders(request.headers);
    }
    delete request.cookies;
    delete request.data;
    delete request.query_string;
  }
  return event;
}

/**
 * Sentry collects user details, cookies, all headers, request and response bodies, query
 * parameters, database parameters, queue payloads, local variables and AI inputs and outputs
 * by default. None of that may leave the process: it holds personal data, customer content
 * (briefs, posts) and credentials. Only a few harmless headers are kept for context.
 */
export const DATA_COLLECTION: NonNullable<NodeOptions['dataCollection']> = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { allow: ['content-type', 'user-agent', 'x-request-id'] },
    response: { allow: ['content-type'] },
  },
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  genAI: { inputs: false, outputs: false },
  graphQL: { document: false, variables: false },
};

type HttpModule = NonNullable<NonNullable<NodeOptions['transportOptions']>['httpModule']>;

/**
 * The http module of the transport behind the egress proxy (guide step 8.9). The transport keeps
 * an agent of its own and reads only the lowercase https_proxy and no_proxy; with these agents it
 * follows HTTPS_PROXY, HTTP_PROXY and NO_PROXY like the other clients of the process.
 */
export function proxiedHttpModule(proxyEnv: ProxyEnv): HttpModule {
  const http = new HttpAgent({ keepAlive: true, maxSockets: 30, proxyEnv });
  const https = new HttpsAgent({ keepAlive: true, maxSockets: 30, proxyEnv });
  return {
    request: (options, callback) => {
      if (typeof options === 'string' || options instanceof URL) {
        throw new TypeError('The transport of Sentry passes request options, not a URL.');
      }
      return options.protocol === 'http:'
        ? httpRequest({ ...options, agent: http }, callback)
        : httpsRequest({ ...options, agent: https }, callback);
    },
  };
}

export function buildSentryOptions(dsn: string, environment: string, proxyEnv?: ProxyEnv): NodeOptions {
  return {
    dsn,
    environment,
    ...(proxyEnv === undefined ? {} : { transportOptions: { httpModule: proxiedHttpModule(proxyEnv) } }),
    dataCollection: DATA_COLLECTION,
    // Defense in depth: scrub the event even if an integration attached request data.
    beforeSend: (event) => scrubEvent(event),
  };
}

/** Initializes Sentry when a DSN is configured. Returns false when error reporting stays off. */
export function startErrorReporting({ dsn, environment, proxyEnv }: ErrorReportingOptions): boolean {
  if (!dsn) {
    return false;
  }

  Sentry.init(buildSentryOptions(dsn, environment, proxyEnv));
  return true;
}
