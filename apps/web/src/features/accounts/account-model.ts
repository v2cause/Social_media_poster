import type { ConnectionStatusDto, PendingConnectionDto } from '@smp/contracts';

// What the accounts page derives from the API (guide step 4.11): how close the end of the access
// is, what an X account cost so far, the initials of an avatar, and which accounts the
// selection after the consent offers ticked.

/** The badge of a connection status. */
export const STATUS_BADGE = {
  ACTIVE: 'default',
  EXPIRING: 'warning',
  NEEDS_REAUTH: 'destructive',
  PAUSED: 'muted',
  REVOKED: 'destructive',
} as const satisfies Record<ConnectionStatusDto, 'default' | 'warning' | 'destructive' | 'muted'>;

/** From this many days on, the page counts the days left instead of naming the date. */
export const COUNTDOWN_DAYS = 14;

const DAY_MS = 86_400_000;

export type AccessExpiry =
  { kind: 'never' } | { kind: 'expired' } | { kind: 'days'; days: number } | { kind: 'date'; date: Date };

/** The end of the access as the page shows it: gone, in a number of days, or on a date. */
export function accessExpiryOf(accessExpiresAt: string | null, now: Date): AccessExpiry {
  if (accessExpiresAt === null) {
    return { kind: 'never' };
  }
  const date = new Date(accessExpiresAt);
  const left = date.getTime() - now.getTime();
  if (left <= 0) {
    return { kind: 'expired' };
  }
  const days = Math.floor(left / DAY_MS);
  return days < COUNTDOWN_DAYS ? { kind: 'days', days } : { kind: 'date', date };
}

/** Micro-USD as US dollars. */
export const usdOf = (micros: number): number => micros / 1_000_000;

/** Up to two initials of a name, for an avatar without picture. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const letters = words.length > 1 ? [words[0], words.at(-1)] : [words[0]];
  return letters
    .map((word) => (word ? Array.from(word)[0] : ''))
    .join('')
    .toUpperCase();
}

/**
 * The accounts ticked when the selection opens: on a reconnect the connected ones, whose access
 * the consent renews; a single account on offer; otherwise none, so nothing is connected
 * without a choice.
 */
export function preselectedAccounts(pending: Pick<PendingConnectionDto, 'accounts' | 'reconnectAccountId'>) {
  if (pending.reconnectAccountId !== null) {
    return new Set(
      pending.accounts.filter((account) => account.connected).map((account) => account.externalId),
    );
  }
  const [only] = pending.accounts;
  return new Set(pending.accounts.length === 1 && only ? [only.externalId] : []);
}
