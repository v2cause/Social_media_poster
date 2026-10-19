import { describe, expect, it } from 'vitest';

import { serverLogLine } from './log';

describe('serverLogLine', () => {
  it('writes one JSON line with the base fields of the other services and the event as msg', () => {
    const line = serverLogLine(
      'error',
      'request.failed',
      { requestId: 'r-1' },
      new Date('2026-10-19T03:00:00Z'),
    );

    expect(JSON.parse(line)).toEqual({
      level: 50,
      time: '2026-10-19T03:00:00.000Z',
      service: 'web',
      env: 'test',
      requestId: 'r-1',
      msg: 'request.failed',
    });
    expect(line).not.toContain('\n');
  });

  it('keeps the base fields when a field of the caller has their names', () => {
    expect(
      JSON.parse(serverLogLine('warn', 'example', { msg: 'other', level: 10, service: 'api', path: '/' })),
    ).toMatchObject({ level: 40, service: 'web', msg: 'example', path: '/' });
  });
});
