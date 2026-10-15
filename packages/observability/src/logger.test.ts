import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runWithLogContext } from './log-context';
import { createLogger } from './logger';

type LogLine = Record<string, unknown>;

function captureLogs(): { lines: LogLine[]; destination: Writable } {
  const lines: LogLine[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as LogLine);
      callback();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('writes service, environment and an ISO timestamp on every line', () => {
    const { lines, destination } = captureLogs();
    const logger = createLogger({ service: 'api', environment: 'test', destination });

    logger.info('app.started');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: 'api', env: 'test', msg: 'app.started' });
    expect(typeof lines[0]?.['time']).toBe('string');
  });

  it('redacts secrets in the logged object and keeps the event name', () => {
    const { lines, destination } = captureLogs();
    const logger = createLogger({ service: 'api', environment: 'test', destination });

    logger.info({ user: { password: 'hunter2' }, requestId: 'req-1' }, 'login.failed');

    expect(JSON.stringify(lines[0])).not.toContain('hunter2');
    expect(lines[0]).toMatchObject({
      user: { password: '[REDACTED]' },
      requestId: 'req-1',
      msg: 'login.failed',
    });
  });

  it('adds the fields of the surrounding log context', () => {
    const { lines, destination } = captureLogs();
    const logger = createLogger({ service: 'worker', environment: 'test', destination });

    runWithLogContext({ jobId: 'job-7', workspaceId: 'ws-1' }, () => {
      logger.info('publish.started');
    });
    logger.info('outside.context');

    expect(lines[0]).toMatchObject({ jobId: 'job-7', workspaceId: 'ws-1' });
    expect(lines[1]).not.toHaveProperty('jobId');
  });

  it('omits traceId when no span is active', () => {
    const { lines, destination } = captureLogs();
    const logger = createLogger({ service: 'api', environment: 'test', destination });

    logger.info('no.span');

    expect(lines[0]).not.toHaveProperty('traceId');
  });
});
