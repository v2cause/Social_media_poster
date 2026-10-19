import { runInJobContext, type ContextJob } from '@smp/observability';

// The log context of a job (architecture 12, ADR 0039, ASVS 16.2.1): the process method of every
// processor runs in the context of its job, see jobLogContext in @smp/observability.

/** Marks the process method that @JobLogContext() wrapped. */
export const JOB_LOG_CONTEXT = Symbol('jobLogContext');

/** Wraps process(job, ...) of a processor in the log context of its job. */
export function JobLogContext(): MethodDecorator {
  return (_target, _key, descriptor) => {
    const original: unknown = descriptor.value;
    if (typeof original !== 'function') {
      throw new TypeError('@JobLogContext() decorates methods only');
    }
    const wrapped = function (this: unknown, job: ContextJob, ...rest: unknown[]): unknown {
      return runInJobContext(job, () =>
        (original as (...args: unknown[]) => unknown).apply(this, [job, ...rest]),
      );
    };
    Object.defineProperty(wrapped, JOB_LOG_CONTEXT, { value: true });
    (descriptor as PropertyDescriptor).value = wrapped;
    return descriptor;
  };
}

/** Whether the method runs in the log context of its job. */
export const hasJobLogContext = (method: unknown): boolean =>
  typeof method === 'function' && (method as unknown as Record<symbol, unknown>)[JOB_LOG_CONTEXT] === true;
