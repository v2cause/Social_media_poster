import { XB_KEYS } from '@smp/x-browser';
import type Redis from 'ioredis';

// One task per X account at a time and at least two minutes between its posts (guide step 6.2),
// across every browser worker: a lock with the id of the command and a key that lives as long
// as the spacing. A task that meets either waits for the time Redis names, without using an
// attempt. The lock outlasts the longest task; after a crash it ends with its TTL.

export const POST_SPACING_MS = 120_000;
export const LOCK_TTL_MS = 10 * 60_000;
/** A busy lock is asked again after this at the latest; the task holding it is usually shorter. */
const LOCK_RECHECK_MS = 15_000;

// KEYS[1] the lock, KEYS[2] the spacing; ARGV[1] the token, ARGV[2] the TTL, ARGV[3] "1" for a
// post. Returns 0 when the lock is taken, else the milliseconds to wait.
const ACQUIRE = `
if ARGV[3] == '1' then
  local spacing = redis.call('pttl', KEYS[2])
  if spacing > 0 then return spacing end
end
if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 0 end
local held = redis.call('pttl', KEYS[1])
if held > 0 then return -held end
return -1000`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export type GuardResult =
  | { kind: 'acquired'; release: () => Promise<void> }
  | { kind: 'busy'; reason: 'locked' | 'spacing'; waitMs: number };

export class AccountGuard {
  constructor(private readonly redis: Redis) {}

  /** Takes the lock of the account for the command; a post also waits for the spacing. */
  async acquire(accountId: string, token: string, post: boolean): Promise<GuardResult> {
    const lock = XB_KEYS.lock(accountId);
    const answer = Number(
      await this.redis.eval(
        ACQUIRE,
        2,
        lock,
        XB_KEYS.spacing(accountId),
        token,
        String(LOCK_TTL_MS),
        post ? '1' : '0',
      ),
    );
    if (answer === 0) {
      return {
        kind: 'acquired',
        release: async () => {
          await this.redis.eval(RELEASE, 1, lock, token).catch(() => undefined);
        },
      };
    }
    return answer > 0
      ? { kind: 'busy', reason: 'spacing', waitMs: answer }
      : { kind: 'busy', reason: 'locked', waitMs: Math.min(-answer, LOCK_RECHECK_MS) };
  }

  /** Starts the spacing after a post of the account, also after one whose outcome is unclear. */
  async spaced(accountId: string): Promise<void> {
    await this.redis.set(XB_KEYS.spacing(accountId), '1', 'PX', POST_SPACING_MS);
  }
}
