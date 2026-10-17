// The countdown of the dashboard (guide step 4.11): within the last hour minutes and seconds,
// before that a relative time such as "in 2 days", and "due" once the time has come.

const HOUR_MS = 3_600_000;

export type Countdown =
  { kind: 'due' } | { kind: 'clock'; minutes: number; seconds: number } | { kind: 'relative' };

export function countdownOf(target: Date, now: Date): Countdown {
  const left = target.getTime() - now.getTime();
  if (left <= 0) {
    return { kind: 'due' };
  }
  if (left >= HOUR_MS) {
    return { kind: 'relative' };
  }
  const seconds = Math.ceil(left / 1000);
  return { kind: 'clock', minutes: Math.floor(seconds / 60), seconds: seconds % 60 };
}
