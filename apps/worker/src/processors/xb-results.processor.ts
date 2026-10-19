import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { BrowserLoginStep } from '@smp/core';
import { parseXbReport, XB_REPORT, XB_RESULTS_QUEUE, type XbReport } from '@smp/x-browser';
import { type Job, UnrecoverableError } from 'bullmq';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import type { PublishPipeline } from '../infrastructure/publisher.providers';
import { JobLogContext } from '../job-log-context';
import { jobsTotal, xbLoginFailuresTotal, xbReportsTotal } from '../metrics';
import { PUBLISH_PIPELINE } from '../worker.tokens';

/**
 * The reports of the browser worker on xb-results, in the role "publisher" (guide step 6.2): a new
 * session replaces the sealed one of its connection, the steps of a login of X move it on and its
 * success stores the browser connection with its account (guide step 6.4), and the circuit
 * breaker counts every drift and failed canary (guide step 6.5). Logs carry ids, statuses and
 * selectors, never sessions.
 */
@Processor(XB_RESULTS_QUEUE, { concurrency: 4 })
export class XbResultsProcessor extends WorkerHost {
  constructor(
    @Inject(PUBLISH_PIPELINE) private readonly pipeline: PublishPipeline,
    @InjectPinoLogger(XbResultsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  @JobLogContext()
  async process(job: Job): Promise<string> {
    if (job.name !== XB_REPORT) {
      throw new UnrecoverableError(`unknown job ${job.name}`);
    }
    let report: XbReport;
    try {
      report = parseXbReport(job.data);
    } catch {
      this.logger.error({ jobId: job.id }, 'xb.report_invalid');
      jobsTotal.inc({ queue: XB_RESULTS_QUEUE, status: 'invalid' });
      throw new UnrecoverableError('invalid xb.result payload');
    }
    const outcome = await this.handle(report);
    jobsTotal.inc({ queue: XB_RESULTS_QUEUE, status: 'completed' });
    xbReportsTotal.inc({ kind: report.kind, outcome });
    return outcome;
  }

  private async handle(report: XbReport): Promise<string> {
    switch (report.kind) {
      case 'session.updated': {
        const stored = await this.pipeline.browserSessions.execute({
          organizationId: report.organizationId,
          workspaceId: report.workspaceId,
          connectionId: report.connectionId,
          externalUserId: report.externalUserId,
          sessionSealed: Buffer.from(report.session, 'base64'),
        });
        this.logger.info({ connectionId: report.connectionId, stored }, 'xb.session_stored');
        return stored ? 'session_stored' : 'session_without_connection';
      }
      case 'drift': {
        const drift = {
          flow: report.flow,
          selector: report.selector,
          selectorsVersion: report.selectorsVersion,
        };
        const breaker = (await this.pipeline.breaker?.drift(drift)) ?? null;
        this.logger.warn({ ...drift, breaker }, 'xb.drift');
        if (breaker?.status === 'opened') {
          this.logger.error({ drifts: breaker.drifts }, 'xb.breaker_opened');
        }
        return `drift_${breaker?.status ?? 'logged'}`;
      }
      case 'canary': {
        const breaker = (await this.pipeline.breaker?.canary(report)) ?? null;
        if (report.ok) {
          this.logger.info({ selectorsVersion: report.selectorsVersion }, 'xb.canary_passed');
        } else {
          this.logger.warn(
            { missing: report.missing, selectorsVersion: report.selectorsVersion, breaker },
            'xb.canary_failed',
          );
        }
        if (breaker?.status === 'opened') {
          this.logger.error({ drifts: breaker.drifts }, 'xb.breaker_opened');
        }
        return report.ok ? 'canary_passed' : 'canary_failed';
      }
      case 'login.status':
        return this.loginStep(report, { kind: 'awaiting_code' });
      case 'login.failed':
        xbLoginFailuresTotal.inc({ failure: report.failure });
        return this.loginStep(report, { kind: 'failed', failure: report.failure });
      case 'login.succeeded': {
        const completion = await this.pipeline.browserLogins.completion.execute({
          organizationId: report.organizationId,
          workspaceId: report.workspaceId,
          loginSessionId: report.loginSessionId,
          user: report.user,
          sessionSealed: Buffer.from(report.session, 'base64'),
        });
        this.logger.info(
          {
            loginSessionId: report.loginSessionId,
            outcome: completion.status,
            ...(completion.status === 'connected'
              ? { connectionId: completion.connectionId, accountId: completion.accountId }
              : {}),
          },
          'xb.login_completed',
        );
        return `login_${completion.status}`;
      }
    }
  }

  private async loginStep(
    report: Extract<XbReport, { kind: 'login.status' | 'login.failed' }>,
    step: BrowserLoginStep,
  ): Promise<string> {
    const recorded = await this.pipeline.browserLogins.steps.execute({
      organizationId: report.organizationId,
      workspaceId: report.workspaceId,
      loginSessionId: report.loginSessionId,
      step,
    });
    this.logger.info(
      {
        loginSessionId: report.loginSessionId,
        step: step.kind,
        ...(step.kind === 'failed' ? { failure: step.failure } : {}),
        recorded,
      },
      'xb.login_step',
    );
    return recorded ? 'login_step' : 'login_step_ignored';
  }
}
