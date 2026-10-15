import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const jobsTotal = new Counter({
  name: 'smp_worker_jobs_total',
  help: 'Jobs handled by this worker, by queue and outcome',
  labelNames: ['queue', 'status'] as const,
  registers: [metricsRegistry],
});
