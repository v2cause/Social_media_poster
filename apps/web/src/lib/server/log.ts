// The server log of the web app (guide step 8.7, ADR 0039, ASVS 16.2.1 and 16.2.4): one JSON line
// per event on stdout, with the fields of the other services: the level as pino numbers it, the
// time in ISO 8601, service and environment, the event as msg. The log processor reads them like
// the lines of API and worker. Callers pass no query, body, cookie, address or error message.

const LEVELS = { info: 30, warn: 40, error: 50 } as const;
/** The fields every line sets itself; a field of the caller with one of these names is dropped. */
const BASE_FIELDS = new Set(['level', 'time', 'service', 'env', 'msg']);

export type ServerLogLevel = keyof typeof LEVELS;

export function serverLogLine(
  level: ServerLogLevel,
  msg: string,
  fields: Record<string, unknown>,
  now = new Date(),
): string {
  return JSON.stringify({
    level: LEVELS[level],
    time: now.toISOString(),
    service: 'web',
    env: process.env.NODE_ENV,
    ...Object.fromEntries(Object.entries(fields).filter(([key]) => !BASE_FIELDS.has(key))),
    msg,
  });
}

export function logServerEvent(level: ServerLogLevel, msg: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${serverLogLine(level, msg, fields)}\n`);
}
