import type { ArgumentsHost } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
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
