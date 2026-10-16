// How long a platform asks to wait (architecture 4.1 and 10): Retry-After (seconds or an HTTP
// date), the reset time of X (x-rate-limit-reset, epoch seconds), Meta's
// X-Business-Use-Case-Usage (estimated_time_to_regain_access in minutes, per business). LinkedIn
// answers 429 without a hint; the caller falls back to a default then.

const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

const clamp = (ms: number): number => Math.min(MAX_WAIT_MS, Math.max(0, Math.round(ms)));

function retryAfterHeader(value: string | null, now: number): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return clamp(Number(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : clamp(date - now);
}

function xReset(value: string | null, now: number): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  return clamp(Number(value.trim()) * 1000 - now);
}

function metaBusinessUsage(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const usage: unknown = JSON.parse(value);
    if (typeof usage !== 'object' || usage === null) {
      return undefined;
    }
    let minutes: number | undefined;
    for (const entries of Object.values(usage)) {
      for (const entry of Array.isArray(entries) ? (entries as unknown[]) : []) {
        const wait = (entry as { estimated_time_to_regain_access?: unknown }).estimated_time_to_regain_access;
        if (typeof wait === 'number' && wait > 0) {
          minutes = Math.max(minutes ?? 0, wait);
        }
      }
    }
    return minutes === undefined ? undefined : clamp(minutes * 60_000);
  } catch {
    return undefined;
  }
}

/** The wait the headers ask for, in milliseconds; undefined when they name none. */
export function retryAfterMsOf(headers: Headers, now = Date.now()): number | undefined {
  const waits = [
    retryAfterHeader(headers.get('retry-after'), now),
    xReset(headers.get('x-rate-limit-reset'), now),
    metaBusinessUsage(headers.get('x-business-use-case-usage')),
  ].filter((wait): wait is number => wait !== undefined);
  return waits.length > 0 ? Math.max(...waits) : undefined;
}
