// Keys whose values never reach a log line, at any depth. Keys are compared without case, "-"
// and "_", so access_token and Access-Token count like accessToken. A key that contains
// "password" or "secret" is redacted too, and one ending in "Enc" holds encrypted material.
const SECRET_KEYS = new Set([
  // HTTP headers
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  // Credentials and tokens in payloads
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessionstate',
  'apikey',
  'appsecretproof',
]);
const SECRET_PARTS = ['password', 'secret'];
const ENCRYPTED_SUFFIX = 'Enc';
const CENSOR = '[REDACTED]';
const MAX_DEPTH = 8;
/** How many causes of an error the log follows. */
const MAX_CAUSES = 3;
/** The fields of an error besides type, message and stack that a log line keeps. */
const ERROR_FIELDS = ['code', 'status', 'statusCode', 'errno', 'syscall'] as const;

const isSecretKey = (key: string): boolean => {
  if (key.endsWith(ENCRYPTED_SUFFIX)) {
    return true;
  }
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return SECRET_KEYS.has(normalized) || SECRET_PARTS.some((part) => normalized.includes(part));
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const EMAIL_ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_WITH_QUERY = /(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/g;

/**
 * Free text such as an error message without email addresses and without the query of URLs,
 * which may carry the token of a link.
 */
export const scrubText = (text: string): string =>
  text.replace(URL_WITH_QUERY, `$1?${CENSOR}`).replace(EMAIL_ADDRESS, '[email]');

/**
 * An error as a log line shows it: its type, message, stack, codes and causes, nothing else.
 * Libraries attach more to their errors, such as the recipients of a mail or the configuration
 * of a request with its headers (guide step 8.4).
 */
export function serializeError(error: Error, depth = 0): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    type: error.constructor.name || error.name,
    message: scrubText(error.message),
  };
  if (error.stack) {
    serialized['stack'] = scrubText(error.stack);
  }
  const fields = error as unknown as Record<string, unknown>;
  for (const field of ERROR_FIELDS) {
    const value = fields[field];
    if (typeof value === 'number') {
      serialized[field] = value;
    } else if (typeof value === 'string') {
      serialized[field] = scrubText(value);
    }
  }
  if (error.cause instanceof Error && depth < MAX_CAUSES) {
    serialized['cause'] = serializeError(error.cause, depth + 1);
  }
  return serialized;
}

/**
 * Returns a copy of the value with every secret key censored and every error reduced by
 * serializeError. The input is not mutated. Dates and other class instances pass through
 * unchanged so pino can serialize them.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactSecrets(item, depth + 1));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = isSecretKey(key) ? CENSOR : redactSecrets(child, depth + 1);
  }
  return copy;
}

/**
 * The serializers of every logger, also for pino-http: the log formatter has reduced errors
 * already, and pino takes the message of an error logged without one as it is.
 */
export const logSerializers = {
  err: (value: unknown): unknown => (value instanceof Error ? serializeError(value) : value),
  msg: (value: unknown): unknown => (typeof value === 'string' ? scrubText(value) : value),
};
