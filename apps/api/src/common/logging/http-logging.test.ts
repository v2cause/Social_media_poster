import express from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { httpLoggingOf } from './http-logging';

// Guide step 8.4: the routes of Better Auth get the same request line as the routes of Nest,
// with the path, without query, cookies or the client address.

describe('the request line of /api/auth', () => {
  it('names request ID, method, path and status, and nothing the request carried', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'info' },
      {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    );
    const app = express();
    app.use((req, _res, next) => {
      (req as { id?: string }).id = 'req-1';
      next();
    });
    app.use('/api/auth', pinoHttp(httpLoggingOf(logger)));
    app.post('/api/auth/sign-in/email', (_req, res) => {
      res.status(401).json({ code: 'INVALID_EMAIL_OR_PASSWORD' });
    });

    app.get('/api/auth/reset-password/:token', (_req, res) => {
      res.redirect('/reset-password');
    });

    await request(app)
      .post('/api/auth/sign-in/email?callbackURL=/after-the-secret-link')
      .set('Cookie', 'smp.session_token=token-of-the-session')
      .set('X-Real-IP', '198.51.100.9')
      .send({ email: 'ada@example.test', password: 'hunter2-secret' })
      .expect(401);
    // The reset link carries its token in the path.
    await request(app).get('/api/auth/reset-password/token-of-the-reset-link?callbackURL=/reset').expect(302);

    expect(lines).toEqual([
      expect.objectContaining({
        req: { id: 'req-1', method: 'POST', path: '/api/auth/sign-in/email' },
        res: { statusCode: 401 },
        msg: 'request completed',
      }),
      expect.objectContaining({
        req: { id: 'req-1', method: 'GET', path: '/api/auth/reset-password/REDACTED' },
        res: { statusCode: 302 },
      }),
    ]);
    expect(JSON.stringify(lines)).not.toMatch(
      /secret|token-of-the-session|token-of-the-reset-link|198\.51\.100\.9|ada@/,
    );
  });
});
