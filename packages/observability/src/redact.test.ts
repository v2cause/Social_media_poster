import { describe, expect, it } from 'vitest';

import { redactSecrets, scrubText, serializeError } from './redact';

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

  it('censors keys in snake_case and kebab-case and every key naming a password or a secret', () => {
    const input = {
      oauth: { access_token: 'at-1', refresh_token: 'rt-1', id_token: 'it-1', client_secret: 'cs-2' },
      meta: { appsecret_proof: 'proof-1', 'X-Api-Key': 'k-3' },
      body: { newPassword: 'np-1', currentPassword: 'cp-1', webhookSecret: 'ws-1' },
      usage: { inputTokens: 1200, outputTokens: 300 },
    };

    const output = redactSecrets(input) as Record<string, unknown>;

    expect(JSON.stringify(output)).not.toMatch(/at-1|rt-1|it-1|cs-2|proof-1|k-3|np-1|cp-1|ws-1/);
    expect(output).toMatchObject({ usage: { inputTokens: 1200, outputTokens: 300 } });
  });

  it('keeps dates and class instances so pino can serialize them', () => {
    const when = new Date('2026-10-15T08:00:00.000Z');
    const url = new URL('https://example.test/');

    const output = redactSecrets({ when, url }) as { when: unknown; url: unknown };

    expect(output.when).toBe(when);
    expect(output.url).toBe(url);
  });
});

describe('serializeError', () => {
  it('keeps type, message, stack, codes and causes of an error and drops everything else', () => {
    class MailError extends Error {
      readonly code = 'EENVELOPE';
      readonly responseCode = 550;
      readonly rejected = ['ada@example.test'];
      readonly response = '550 5.1.1 <ada@example.test>: Recipient address rejected';
    }
    const error = new MailError('Can not send mail: <ada@example.test> was rejected', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { syscall: 'connect', errno: -111 }),
    });

    const output = redactSecrets({ err: error }) as { err: Record<string, unknown> };

    expect(output.err).toMatchObject({
      type: 'MailError',
      message: 'Can not send mail: <[email]> was rejected',
      code: 'EENVELOPE',
      cause: { type: 'Error', message: 'connect ECONNREFUSED', syscall: 'connect', errno: -111 },
    });
    expect(output.err).not.toHaveProperty('rejected');
    expect(output.err).not.toHaveProperty('response');
    expect(JSON.stringify(output)).not.toContain('ada@example.test');
  });

  it('follows at most three causes', () => {
    let error = new Error('level 0');
    for (let level = 1; level <= 5; level += 1) {
      error = new Error(`level ${String(level)}`, { cause: error });
    }

    const serialized = serializeError(error);

    expect(JSON.stringify(serialized).match(/level/g)?.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(serialized)).not.toContain('level 0');
  });
});

describe('scrubText', () => {
  it('removes email addresses and the query of URLs', () => {
    expect(
      scrubText(
        'GET https://example.test/api/auth/verify-email?token=abc.def failed for bob.smith+x@mail.example.org',
      ),
    ).toBe('GET https://example.test/api/auth/verify-email?[REDACTED] failed for [email]');
    expect(scrubText('nothing to hide')).toBe('nothing to hide');
  });
});
