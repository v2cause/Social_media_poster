import { STATUS_CODES } from 'node:http';

import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  traceId: string;
}

const UNEXPECTED_ERROR: Pick<ProblemDetails, 'status' | 'code' | 'detail'> = {
  status: 500,
  code: 'INTERNAL_ERROR',
  detail: 'An unexpected error occurred.',
};

/**
 * Renders every error as an RFC 9457 problem document. Stack traces and internal messages
 * never reach the client: server errors (5xx) always get a generic detail, also when they were
 * thrown as an HttpException. The code is the stable key the UI translates.
 *
 * Server errors are logged with the error itself (name, message, stack), so they can be traced
 * through the request ID without exposing anything to the caller.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    // pino-http types req.id as a required ReqId; the request-id middleware sets a string.
    const requestId = typeof request.id === 'string' ? request.id : 'unknown';

    const problem = this.toProblem(exception, requestId);
    if (problem.status >= 500) {
      this.logger.error({ code: problem.code, requestId, err: exception }, 'request.failed');
    }

    response.status(problem.status).type('application/problem+json').json(problem);
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
