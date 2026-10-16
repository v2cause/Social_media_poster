import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const jobsTotal = new Counter({
  name: 'smp_worker_jobs_total',
  help: 'Jobs handled by this worker, by queue and outcome',
  labelNames: ['queue', 'status'] as const,
  registers: [metricsRegistry],
});

/** Publish jobs that failed for good; the alarm "dead-letter queue not empty" watches it. */
export const publishDeadLettersTotal = new Counter({
  name: 'smp_worker_publish_dead_letters_total',
  help: 'Publish jobs that failed for good and went to the dead-letter queue',
  registers: [metricsRegistry],
});
