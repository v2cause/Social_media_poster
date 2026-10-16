import type { ArgumentsHost } from '@nestjs/common';
import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ZodValidationException } from 'nestjs-zod';

import { ProblemDetailsFilter } from './problem-details.filter';

function renderWith(exception: unknown) {
  const response = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const request = { id: 'req-1' };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;

  new ProblemDetailsFilter().catch(exception, host);

  return { response, body: response.json.mock.calls[0]?.[0] as Record<string, unknown> };
}

describe('ProblemDetailsFilter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an HTTP exception as a problem document with its status', () => {
    const { response, body } = renderWith(new NotFoundException('Workspace not found'));

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.type).toHaveBeenCalledWith('application/problem+json');
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'HTTP_404',
      detail: 'Workspace not found',
      traceId: 'req-1',
    });
  });

  it('hides the message and stack of unexpected errors', () => {
    const error = new Error('connect failed: password=hunter2');

    const { response, body } = renderWith(error);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(body).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(body).not.toHaveProperty('stack');
  });

  it('hides internal messages of server errors thrown as HTTP exceptions', () => {
    const { response, body } = renderWith(new ServiceUnavailableException('redis at 10.0.0.5:6379 refused'));

    expect(response.status).toHaveBeenCalledWith(503);
    expect(body).toMatchObject({ status: 503, code: 'HTTP_503', detail: 'An unexpected error occurred.' });
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('logs server errors with the error itself and the request ID', () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const error = new Error('boom');

    renderWith(error);

    expect(logError).toHaveBeenCalledWith(
      { code: 'INTERNAL_ERROR', requestId: 'req-1', err: error },
      'request.failed',
    );
  });

  it('does not log client errors', () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    renderWith(new NotFoundException());

    expect(logError).not.toHaveBeenCalled();
  });

  it('maps schema validation failures to a stable code', () => {
    const issue = z.object({ name: z.string() }).safeParse({ name: 1 }).error;
    if (!issue) {
      throw new Error('expected a validation error');
    }

    const { response, body } = renderWith(new ZodValidationException(issue));

    expect(response.status).toHaveBeenCalledWith(400);
    expect(body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});
