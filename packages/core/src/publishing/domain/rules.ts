import type { ConnectionStatus } from '../../channels/domain/types';
import type { MemberRole } from '../../tenancy/domain/types';

// Rules of scheduling and publishing (architecture 7 and 10).

/** Editors and above plan, post now and retry; viewers read the calendar. */
export const canPublish = (role: MemberRole): boolean => role !== 'VIEWER';

/** Connections that may publish. EXPIRING still works until the access runs out. */
export const isConnectionUsable = (status: ConnectionStatus): boolean =>
  status === 'ACTIVE' || status === 'EXPIRING';

/** Variants overdue by more than this fail with MISSED_WINDOW instead of going out late (step 4.7). */
export const MISSED_WINDOW_MS = 6 * 60 * 60 * 1000;

/** What a plan reports without refusing it. */
export const SCHEDULE_WARNINGS = ['ACCESS_EXPIRES_BEFORE_PUBLISH', 'ACCOUNT_EXPIRING'] as const;
export type ScheduleWarning = (typeof SCHEDULE_WARNINGS)[number];
