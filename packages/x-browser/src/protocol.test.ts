import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseXbCommand,
  parseXbOutcome,
  parseXbReport,
  XB_KEYS,
  XB_OPERATIONS,
  xbCommandName,
  xbLoginAad,
  xbOperationOf,
  xbSessionAad,
} from './protocol';

// Guide step 6.2: the commands to the browser worker carry what it needs and nothing in
// plaintext that is secret; outcomes and reports are checked on the way back.

const target = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  accountId: randomUUID(),
  externalUserId: '1234567890',
  handle: 'smp_demo',
  locale: 'de',
  session: Buffer.from('sealed').toString('base64'),
} as const;
const command = { commandId: randomUUID(), deadline: '2026-10-17T08:10:00.000Z' };

describe('X browser protocol', () => {
  it('names the jobs of the commands and finds the operation of a job again', () => {
    for (const operation of XB_OPERATIONS) {
      expect(xbOperationOf(xbCommandName(operation))).toBe(operation);
    }
    expect(xbOperationOf('xb.unknown')).toBeNull();
    expect(xbOperationOf('publish')).toBeNull();
  });

  it('checks a post with up to four images and refuses a session that is no envelope', () => {
    const publish = {
      ...command,
      target,
      text: 'Hallo X',
      media: [{ url: 'https://storage.example/a.jpg?sig=1', mimeType: 'image/jpeg', altText: null }],
    };
    expect(parseXbCommand('publish', publish)).toEqual(publish);
    expect(() =>
      parseXbCommand('publish', { ...publish, target: { ...target, session: 'not base64!' } }),
    ).toThrow();
    expect(() =>
      parseXbCommand('publish', { ...publish, media: Array.from({ length: 5 }, () => publish.media[0]) }),
    ).toThrow();
    expect(() => parseXbCommand('metrics', { ...command, target, externalPostIds: ['1', 'x2'] })).toThrow();
  });

  it('carries the credentials of a login sealed only', () => {
    const login = {
      ...command,
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      loginSessionId: randomUUID(),
      locale: 'en',
      credentials: Buffer.from('sealed credentials').toString('base64'),
    };
    expect(parseXbCommand('login.start', login)).toEqual(login);
    expect(() =>
      parseXbCommand('login.start', { ...login, credentials: { username: 'u', password: 'p' } }),
    ).toThrow();
  });

  it('checks outcomes and reports', () => {
    expect(
      parseXbOutcome('publish', {
        ok: true,
        data: {
          externalPostId: '1850000000000000001',
          externalUrl: 'https://x.com/smp_demo/status/1850000000000000001',
          publishedAt: '2026-10-17T08:00:05.000Z',
        },
      }).ok,
    ).toBe(true);
    expect(
      parseXbOutcome('delete', { ok: false, error: { code: 'CHALLENGE_REQUIRED', message: 'X asks.' } }),
    ).toEqual({
      ok: false,
      error: { code: 'CHALLENGE_REQUIRED', message: 'X asks.' },
    });
    expect(() => parseXbOutcome('delete', { ok: false, error: { code: 'GUESSED', message: '' } })).toThrow();
    expect(
      parseXbReport({
        kind: 'drift',
        flow: 'publish',
        selector: 'composer.submit',
        selectorsVersion: 'x-v1',
      }),
    ).toEqual({
      kind: 'drift',
      flow: 'publish',
      selector: 'composer.submit',
      selectorsVersion: 'x-v1',
    });
    expect(() => parseXbReport({ kind: 'login.succeeded', session: 'x' })).toThrow();
  });

  it('binds a session to its workspace and X user and the secrets of a login to the login', () => {
    expect(xbSessionAad('ws-1', '42')).toBe('ws-1:x-browser.42:session');
    expect(xbLoginAad('ws-1', 'login-1', 'credentials')).toBe('ws-1:xb-login.login-1:credentials');
    expect(xbLoginAad('ws-1', 'login-1', 'code')).not.toBe(xbLoginAad('ws-1', 'login-1', 'credentials'));
  });

  it('keeps the Redis keys of the browser worker under xb:', () => {
    expect([XB_KEYS.kill, XB_KEYS.lock('a'), XB_KEYS.spacing('a'), XB_KEYS.loginInput('l')]).toEqual([
      'xb:kill',
      'xb:lock:a',
      'xb:spacing:a',
      'xb:login:l:input',
    ]);
  });
});
