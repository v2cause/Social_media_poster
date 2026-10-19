import type { ArgumentsHost } from '@nestjs/common';
import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ZodValidationException } from 'nestjs-zod';
import {
  AiCallFailedError,
  AiRateLimitedError,
  LastOwnerError,
  NotPermittedError,
  QuotaExceededError,
  ScheduleTimeInGapError,
  WebhookSignatureInvalidError,
  WorkspaceNotFoundError,
} from '@smp/core';

import { InvalidPasswordError } from '../../modules/identity/password-check';
import { ProblemDetailsFilter } from './problem-details.filter';

function renderWith(exception: unknown, request: Record<string, unknown> = { id: 'req-1' }) {
  const response = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
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

  it('renders domain errors with their code and the status of their kind', () => {
    expect(renderWith(new LastOwnerError()).body).toMatchObject({ status: 409, code: 'LAST_OWNER' });
    expect(renderWith(new NotPermittedError()).body).toMatchObject({ status: 403, code: 'NOT_PERMITTED' });
    expect(renderWith(new WorkspaceNotFoundError()).body).toMatchObject({
      status: 404,
      code: 'WORKSPACE_NOT_FOUND',
    });
    expect(renderWith(new QuotaExceededError('ai_micros')).body).toMatchObject({
      status: 402,
      code: 'QUOTA_EXCEEDED',
    });
    expect(renderWith(new AiRateLimitedError()).body).toMatchObject({ status: 429, code: 'AI_RATE_LIMITED' });
    expect(renderWith(new AiCallFailedError({ code: 'PROVIDER_ERROR', retryable: true })).body).toMatchObject(
      {
        status: 503,
        code: 'AI_PROVIDER_ERROR',
      },
    );
  });

  it('passes the parameters of a domain error on, and leaves them out without any', () => {
    const { body } = renderWith(new ScheduleTimeInGapError('2027-03-28T03:00', 'Europe/Berlin'));

    expect(body).toMatchObject({
      status: 422,
      code: 'SCHEDULE_TIME_IN_GAP',
      params: { suggestion: '2027-03-28T03:00', timeZone: 'Europe/Berlin' },
    });
    expect(renderWith(new LastOwnerError()).body).not.toHaveProperty('params');
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

  describe('security events (guide step 8.4)', () => {
    const request = {
      id: 'req-1',
      method: 'PATCH',
      originalUrl: '/api/w/acme/settings',
      route: { path: '/api/w/:ws/settings' },
      params: { ws: 'acme' },
      headers: { 'x-real-ip': '203.0.113.5' },
      access: { role: 'VIEWER' },
    };
    const securityEvents = (warn: { mock: { calls: unknown[][] } }) =>
      warn.mock.calls.filter((call) => String(call[1]).startsWith('security.'));

    it('logs a refusal of the role with route, role and tenant', () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      renderWith(new NotPermittedError(), request);

      expect(securityEvents(warn)).toEqual([
        [
          {
            method: 'PATCH',
            route: '/api/w/:ws/settings',
            clientAddress: '203.0.113.5',
            status: 403,
            code: 'NOT_PERMITTED',
            role: 'VIEWER',
            tenant: 'acme',
          },
          'security.permission_denied',
        ],
      ]);
    });

    it('names the failed fields of a schema without their values', () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = z
        .object({ password: z.string().min(12), profile: z.object({ email: z.email() }) })
        .safeParse({ password: 'hunter2', profile: { email: 'not-an-address' } }).error;

      renderWith(new ZodValidationException(error), request);

      const [event] = securityEvents(warn);
      expect(event?.[1]).toBe('security.validation_failed');
      expect(event?.[0]).toMatchObject({
        issues: [
          { path: 'password', code: 'too_small' },
          { path: 'profile.email', code: 'invalid_format' },
        ],
      });
      expect(JSON.stringify(event)).not.toMatch(/hunter2|not-an-address/);
    });

    it('logs tenants without membership, rate limits, webhooks without signature and wrong passwords, nothing else', () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      renderWith(new WorkspaceNotFoundError(), request);
      renderWith(new AiRateLimitedError(), request);
      renderWith(new WebhookSignatureInvalidError(), { id: 'req-2', method: 'POST' });
      renderWith(new InvalidPasswordError(), request);
      renderWith(new LastOwnerError(), request);
      renderWith(new NotFoundException(), request);

      expect(securityEvents(warn).map((call) => call[1])).toEqual([
        'security.tenant_denied',
        'security.rate_limited',
        'security.webhook_rejected',
        'security.password_rejected',
      ]);
    });
  });
});
