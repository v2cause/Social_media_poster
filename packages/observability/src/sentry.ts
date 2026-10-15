import * as Sentry from '@sentry/node';

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

/** Initializes Sentry when a DSN is configured. Returns false when error reporting stays off. */
export function startErrorReporting({ dsn, environment }: ErrorReportingOptions): boolean {
  if (!dsn) {
    return false;
  }

  Sentry.init({
    dsn,
    environment,
    beforeSend(event) {
      if (event.request?.headers) {
        event.request.headers = scrubRequestHeaders(event.request.headers);
      }
      return event;
    },
  });
  return true;
}
