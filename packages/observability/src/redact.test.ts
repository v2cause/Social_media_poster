import { describe, expect, it } from 'vitest';

import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('censors secret keys at any depth', () => {
    const input = {
      req: { headers: { authorization: 'Bearer abc', cookie: 'session=xyz', 'x-request-id': 'r-1' } },
      user: { password: 'hunter2', apiKey: 'k-1', nested: { refreshToken: 'rt', sessionState: 'st' } },
      tokenEnc: 'ciphertext',
    };

    const output = redactSecrets(input) as Record<string, unknown>;

    expect(JSON.stringify(output)).not.toMatch(/Bearer abc|session=xyz|hunter2|k-1|"rt"|"st"|ciphertext/);
    expect(output).toMatchObject({ req: { headers: { 'x-request-id': 'r-1' } } });
  });

  it('censors response cookies, proxy credentials and further token fields', () => {
    const input = {
      res: { headers: { 'set-cookie': 'session=new', 'content-type': 'application/json' } },
      req: { headers: { 'proxy-authorization': 'Basic abc', 'x-api-key': 'k-2' } },
      oauth: { token: 't-1', idToken: 'id-1', clientSecret: 'cs-1', secret: 's-1' },
    };

    const output = redactSecrets(input) as Record<string, unknown>;

    expect(JSON.stringify(output)).not.toMatch(/session=new|Basic abc|k-2|t-1|id-1|cs-1|s-1/);
    expect(output).toMatchObject({ res: { headers: { 'content-type': 'application/json' } } });
  });

  it('does not mutate the input', () => {
    const input = { password: 'hunter2' };

    redactSecrets(input);

    expect(input).toEqual({ password: 'hunter2' });
  });

  it('keeps dates, errors and class instances so pino can serialize them', () => {
    const when = new Date('2026-10-15T08:00:00.000Z');
    const error = new Error('boom');

    const output = redactSecrets({ when, err: error }) as { when: unknown; err: unknown };

    expect(output.when).toBe(when);
    expect(output.err).toBe(error);
  });
});
