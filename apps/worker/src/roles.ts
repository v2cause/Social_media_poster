export const WORKER_ROLES = [
  'scheduler',
  'publisher',
  'analytics',
  'media',
  'ai',
  'notify',
  'billing',
  'gdpr',
] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

const KNOWN_ROLES = new Set<string>(WORKER_ROLES);

/**
 * Parses WORKER_ROLES, for example "scheduler,publisher". Only the processors of the
 * named roles are loaded. Empty or unknown input stops the start. Role names are not secrets.
 */
export function parseRoles(input: string): WorkerRole[] {
  const requested = input
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);

  if (requested.length === 0) {
    throw new Error(`WORKER_ROLES must name at least one role. Allowed: ${WORKER_ROLES.join(', ')}.`);
  }

  const unknown = requested.filter((role) => !KNOWN_ROLES.has(role));
  if (unknown.length > 0) {
    throw new Error(`Unknown worker role(s): ${unknown.join(', ')}. Allowed: ${WORKER_ROLES.join(', ')}.`);
  }

  return [...new Set(requested as WorkerRole[])];
}
