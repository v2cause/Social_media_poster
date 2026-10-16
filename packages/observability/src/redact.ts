// Keys whose values never reach a log line, at any depth. A key ending in "Enc" holds
// encrypted material and is redacted as well.
const SECRET_KEYS = new Set([
  // HTTP headers (Node lowercases their names)
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  // Credentials and tokens in payloads
  'password',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionState',
  'apiKey',
]);
const ENCRYPTED_SUFFIX = 'Enc';
const CENSOR = '[REDACTED]';
const MAX_DEPTH = 8;

const isSecretKey = (key: string): boolean => SECRET_KEYS.has(key) || key.endsWith(ENCRYPTED_SUFFIX);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Returns a copy of the value with every secret key censored. The input is not mutated.
 * Errors, dates and other class instances pass through unchanged so pino can serialize them.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
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
