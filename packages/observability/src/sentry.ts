import * as Sentry from '@sentry/node';
import type { ErrorEvent, NodeOptions } from '@sentry/node';

export interface ErrorReportingOptions {
  dsn?: string;
  environment: string;
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

export function buildSentryOptions(dsn: string, environment: string): NodeOptions {
  return {
    dsn,
    environment,
    dataCollection: DATA_COLLECTION,
    // Defense in depth: scrub the event even if an integration attached request data.
    beforeSend: (event) => scrubEvent(event),
  };
}

/** Initializes Sentry when a DSN is configured. Returns false when error reporting stays off. */
export function startErrorReporting({ dsn, environment }: ErrorReportingOptions): boolean {
  if (!dsn) {
    return false;
  }

  Sentry.init(buildSentryOptions(dsn, environment));
  return true;
}
