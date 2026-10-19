import { runWithLogContext, type LogContext } from './log-context';

// The log context of a job (architecture 12, ADR 0039, ASVS 16.2.1): every line written while a
// job runs, by its processor, by the use cases of the core or by an adapter, carries the ID, the
// queue and the name of the job and, where the payload names them, the organization and the
// workspace. Nothing else of the payload goes into the context.

/** The fields of a BullMQ job that its log context reads. */
export interface ContextJob {
  id?: string | undefined;
  name: string;
  queueName: string;
  data: unknown;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const tenantOf = (data: unknown, field: 'organizationId' | 'workspaceId'): string | undefined => {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
};

export function jobLogContext(job: ContextJob): LogContext {
  const organizationId = tenantOf(job.data, 'organizationId');
  const workspaceId = tenantOf(job.data, 'workspaceId');
  return {
    ...(job.id === undefined ? {} : { jobId: job.id }),
    queue: job.queueName,
    job: job.name,
    ...(organizationId ? { organizationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/** Runs work in the log context of the job. */
export const runInJobContext = <T>(job: ContextJob, work: () => T): T =>
  runWithLogContext(jobLogContext(job), work);
