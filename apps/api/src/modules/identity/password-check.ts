import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@smp/core';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../../infrastructure/clients.module';
import { AUTH, type Auth } from './auth';

// Asks for the password again before a sensitive action, for example switching the X browser on
// (guide step 6.1). Better Auth checks the password of the session's user. The attempts per user
// are limited, so a stolen session cannot guess the password through this check.

export class InvalidPasswordError extends DomainError {
  readonly code = 'INVALID_PASSWORD';
  readonly kind = 'invalid';
  constructor() {
    super('The password is not correct.');
  }
}

export class TooManyAttemptsError extends DomainError {
  readonly code = 'TOO_MANY_ATTEMPTS';
  readonly kind = 'rate_limited';
  constructor() {
    super('Too many attempts; wait before trying again.');
  }
}

/** Attempts per user and window. */
const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60;

// INCR with an expiry set on the first hit, as in the rate limits of the AI routes.
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

@Injectable()
export class PasswordCheck {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Throws InvalidPasswordError, or TooManyAttemptsError after five attempts in 15 minutes. */
  async verify(request: Request, userId: string, password: string, now = Date.now()): Promise<void> {
    const window = Math.floor(now / (WINDOW_SECONDS * 1000));
    const attempts = Number(
      await this.redis.eval(
        INCREMENT,
        1,
        `password-check:${userId}:${String(window)}`,
        String(WINDOW_SECONDS),
      ),
    );
    if (attempts > MAX_ATTEMPTS) {
      throw new TooManyAttemptsError();
    }
    try {
      await this.auth.api.verifyPassword({ body: { password }, headers: fromNodeHeaders(request.headers) });
    } catch {
      throw new InvalidPasswordError();
    }
  }
}
