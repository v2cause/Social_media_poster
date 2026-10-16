import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiFetch } from './fetcher';

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the JSON body and nothing for 204', async () => {
    respond(200, { ok: true });
    await expect(apiFetch('/api/me', { method: 'GET' })).resolves.toEqual({ ok: true });
    respond(204, undefined);
    await expect(apiFetch('/api/org/x/leave', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('throws an ApiError with the code of the problem document', async () => {
    respond(409, { type: 'about:blank', title: 'Conflict', status: 409, code: 'LAST_OWNER', traceId: 't-1' });
    await expect(apiFetch('/api/org/x/leave', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      code: 'LAST_OWNER',
      traceId: 't-1',
    });
  });

  it('keeps the parameters of the problem document for the message', async () => {
    respond(422, {
      status: 422,
      code: 'SCHEDULE_TIME_IN_GAP',
      params: { suggestion: '2027-03-28T03:00', timeZone: 'Europe/Berlin' },
    });
    await expect(apiFetch('/api/w/x/variants/v/schedule', { method: 'POST' })).rejects.toMatchObject({
      code: 'SCHEDULE_TIME_IN_GAP',
      params: { suggestion: '2027-03-28T03:00', timeZone: 'Europe/Berlin' },
    });
  });

  it('falls back to the HTTP status when the body is no problem document', async () => {
    respond(502, 'Bad gateway');
    const error: unknown = await apiFetch('/api/me', { method: 'GET' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'HTTP_502' });
  });
});
