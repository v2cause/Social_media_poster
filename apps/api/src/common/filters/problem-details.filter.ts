import { STATUS_CODES } from 'node:http';

import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { isDomainError, type DomainErrorKind, type DomainErrorParams } from '@smp/core';
import type { Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';

import type { RequestWithAccess } from '../guards/request-access';
import { clipped, logSecurityEvent, type SecurityEvent } from '../logging/security-events';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  traceId: string;
  /** Values for the translated message of a domain error, for example a suggested time. */
  params?: DomainErrorParams;
}

/** HTTP status per kind of domain error (guide B.1). */
const STATUS_BY_KIND: Record<DomainErrorKind, number> = {
  invalid: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  quota_exceeded: 402,
  rate_limited: 429,
  unavailable: 503,
};

const UNEXPECTED_ERROR: Pick<ProblemDetails, 'status' | 'code' | 'detail'> = {
  status: 500,
  code: 'INTERNAL_ERROR',
  detail: 'An unexpected error occurred.',
};

/**
 * The refusals that are security events (guide step 8.4, ASVS 16.3.2 and 16.3.3), by their code;
 * every answer 429 is one as well.
 */
const SECURITY_EVENTS: Partial<Record<string, SecurityEvent>> = {
  VALIDATION_FAILED: 'security.validation_failed',
  WORKSPACE_NOT_FOUND: 'security.tenant_denied',
  ORGANIZATION_NOT_FOUND: 'security.tenant_denied',
  NOT_PERMITTED: 'security.permission_denied',
  INVITATION_EMAIL_MISMATCH: 'security.permission_denied',
  TWO_FACTOR_REQUIRED: 'security.two_factor_required',
  WEBHOOK_SIGNATURE_INVALID: 'security.webhook_rejected',
  // PasswordCheck; after five attempts it answers 429 and the event is security.rate_limited.
  INVALID_PASSWORD: 'security.password_rejected',
};

/** How many failed fields of a schema an event names. */
const MAX_ISSUES = 10;

/** The fields that failed and why, without their values: a value can be a password or a token. */
function issuesOf(exception: ZodValidationException): { path: string; code: string }[] {
  const issues = (exception.getZodError() as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.slice(0, MAX_ISSUES).map((issue: { path?: unknown; code?: unknown }) => ({
    path: Array.isArray(issue.path) ? issue.path.map(String).join('.') : '',
    code: typeof issue.code === 'string' ? issue.code : 'unknown',
  }));
}

/**
 * Renders every error as an RFC 9457 problem document. Stack traces and internal messages
 * never reach the client: server errors (5xx) always get a generic detail, also when they were
 * thrown as an HttpException. The code is the stable key the UI translates.
 *
 * Server errors are logged with the error itself (name, message, stack), so they can be traced
 * through the request ID without exposing anything to the caller. Refusals that may be an attack
 * are logged as security events.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithAccess & { id?: string }>();
    const response = http.getResponse<Response>();
    // pino-http types req.id as a required ReqId; the request-id middleware sets a string.
    const requestId = typeof request.id === 'string' ? request.id : 'unknown';

    const problem = this.toProblem(exception, requestId);
    if (problem.status >= 500) {
      this.logger.error({ code: problem.code, requestId, err: exception }, 'request.failed');
    }
    const event = SECURITY_EVENTS[problem.code] ?? (problem.status === 429 ? 'security.rate_limited' : null);
    if (event) {
      logSecurityEvent(event, request, this.eventFields(exception, request, problem));
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  /** What a security event adds to the route: the code, the role and the tenant, failed fields. */
  private eventFields(
    exception: unknown,
    request: RequestWithAccess,
    problem: ProblemDetails,
  ): Record<string, unknown> {
    const params = request.params as Record<string, unknown> | undefined;
    const tenant = clipped(params?.['ws'] ?? params?.['org']);
    return {
      status: problem.status,
      code: problem.code,
      ...(request.access ? { role: request.access.role } : {}),
      ...(tenant ? { tenant } : {}),
      ...(exception instanceof ZodValidationException ? { issues: issuesOf(exception) } : {}),
    };
  }

  private toProblem(exception: unknown, requestId: string): ProblemDetails {
    const traceId = trace.getActiveSpan()?.spanContext().traceId ?? requestId;

    if (exception instanceof ZodValidationException) {
      return {
        type: 'about:blank',
        title: STATUS_CODES[400] ?? 'Bad Request',
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'The request does not match the expected schema.',
        traceId,
      };
    }

    if (isDomainError(exception)) {
      const status = STATUS_BY_KIND[exception.kind];
      return {
        type: 'about:blank',
        title: STATUS_CODES[status] ?? 'Error',
        status,
        code: exception.code,
        detail: exception.message,
        traceId,
        ...(exception.params ? { params: exception.params } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: 'about:blank',
        title: STATUS_CODES[status] ?? 'Error',
        status,
        code: `HTTP_${String(status)}`,
        detail: status >= 500 ? UNEXPECTED_ERROR.detail : exception.message,
        traceId,
      };
    }

    return {
      type: 'about:blank',
      title: STATUS_CODES[UNEXPECTED_ERROR.status] ?? 'Internal Server Error',
      ...UNEXPECTED_ERROR,
      traceId,
    };
  }
}
