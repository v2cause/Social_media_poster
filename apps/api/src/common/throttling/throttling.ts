import { isIP } from 'node:net';

import { type ExecutionContext, Injectable, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  hours,
  minutes,
  normalizeIp,
  Throttle,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  ThrottlerModule,
} from '@nestjs/throttler';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../../infrastructure/clients.module';
import type { AuthSession } from '../../modules/identity/auth';
import { RedisThrottlerStorage } from './redis-throttler-storage';

// Inbound rate limits (architecture 10, guide step 8.4, ADR 0039) with @nestjs/throttler, counted
// in Redis. Three throttlers:
// - "address": requests per client address and minute, before the session is checked, so that
//   a flood of requests does not reach the session lookup,
// - "user": requests per user (per address without a session) and minute, across all routes,
// - "route": the tighter limit of a route marked with @LimitPerUser, per user and route.
// The client address is X-Real-IP, which the reverse proxy sets, as for Better Auth (ADR 0006).

export interface InboundRateLimits {
  perAddressPerMinute: number;
  perUserPerMinute: number;
  /** The limits of @LimitPerUser; only tests of other features turn them off. */
  routeLimits: boolean;
}

export const INBOUND_RATE_LIMITS = Symbol('INBOUND_RATE_LIMITS');

/** An office behind one address fits in; a single user hardly ever makes 10 requests a second. */
export const DEFAULT_INBOUND_RATE_LIMITS: InboundRateLimits = {
  perAddressPerMinute: 3000,
  perUserPerMinute: 600,
  routeLimits: true,
};

const ROUTE = 'route';
/** The metadata key of the limit that @Throttle sets for a throttler (THROTTLER_LIMIT). */
const LIMIT_METADATA = 'THROTTLER:LIMIT';

/** What the throttlers read from a request; AuthGuard sets auth. */
interface TrackedRequest {
  headers?: Record<string, unknown>;
  ip?: string;
  auth?: AuthSession;
}

/** A tighter limit for one route, per user (or client address) and window. */
export const LimitPerUser = (limit: number, ttl: number) => Throttle({ [ROUTE]: { limit, ttl } });

/** The address of the client: X-Real-IP from the reverse proxy, IPv6 by its /64 network. */
export function clientAddress(req: TrackedRequest): string {
  const header = req.headers?.['x-real-ip'];
  const address = typeof header === 'string' && isIP(header) ? header : (req.ip ?? 'unknown');
  return normalizeIp(address);
}

/** The throttlers hand the request over as a plain record. */
type ThrottledRequest = Record<string, unknown>;

const userOrAddress = (req: ThrottledRequest): Promise<string> => {
  const tracked = req as TrackedRequest;
  const userId = tracked.auth?.user.id;
  return Promise.resolve(userId ? `user:${userId}` : `address:${clientAddress(tracked)}`);
};
const reflector = new Reflector();
const hasRouteLimit = (context: ExecutionContext): boolean =>
  reflector.getAllAndOverride<unknown>(LIMIT_METADATA + ROUTE, [context.getHandler(), context.getClass()]) !==
  undefined;

/** Runs only the named throttlers, so that the guards sit at their own places in the pipeline. */
abstract class NamedThrottlerGuard extends ThrottlerGuard {
  protected abstract readonly names: readonly string[];

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((throttler) => this.names.includes(throttler.name ?? ''));
  }

  /** A refused request learns when to try again, in the standard header only. */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader: (name: string, value: string) => void }>();
    response.setHeader('Retry-After', String(Math.max(1, detail.timeToBlockExpire)));
    await super.throwThrottlingException(context, detail);
  }
}

/** Before the session: requests per client address. */
@Injectable()
export class AddressThrottlerGuard extends NamedThrottlerGuard {
  protected readonly names = ['address'];
}

/** After the session: requests per user, and the limits of single routes. */
@Injectable()
export class UserThrottlerGuard extends NamedThrottlerGuard {
  protected readonly names = ['user', ROUTE];
}

@Module({
  providers: [{ provide: INBOUND_RATE_LIMITS, useValue: DEFAULT_INBOUND_RATE_LIMITS }],
  exports: [INBOUND_RATE_LIMITS],
})
class InboundRateLimitsModule {}

/** The throttlers and their storage; the guards are registered in the request pipeline (AccessModule). */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [InboundRateLimitsModule],
      inject: [REDIS_CLIENT, INBOUND_RATE_LIMITS],
      useFactory: (redis: Redis, limits: InboundRateLimits) => ({
        storage: new RedisThrottlerStorage(redis),
        errorMessage: 'Too many requests; wait before trying again.',
        // No X-RateLimit headers on every answer; a refusal carries Retry-After.
        setHeaders: false,
        throttlers: [
          {
            name: 'address',
            ttl: minutes(1),
            limit: limits.perAddressPerMinute,
            getTracker: (req: ThrottledRequest) => Promise.resolve(clientAddress(req as TrackedRequest)),
            generateKey: (_context: ExecutionContext, tracker: string) => tracker,
          },
          {
            name: 'user',
            ttl: minutes(1),
            limit: limits.perUserPerMinute,
            getTracker: userOrAddress,
            generateKey: (_context: ExecutionContext, tracker: string) => tracker,
          },
          {
            // Without @LimitPerUser a route has no limit of its own.
            name: ROUTE,
            ttl: hours(1),
            limit: Number.MAX_SAFE_INTEGER,
            skipIf: (context: ExecutionContext) => !limits.routeLimits || !hasRouteLimit(context),
            getTracker: userOrAddress,
            generateKey: (context: ExecutionContext, tracker: string) =>
              `${context.getClass().name}.${context.getHandler().name}:${tracker}`,
          },
        ],
      }),
    }),
  ],
})
export class ThrottlingModule {}
