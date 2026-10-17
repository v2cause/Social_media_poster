import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { liveEventChannel, parseLiveEvent, type LiveEvent } from '@smp/queue';
import Redis from 'ioredis';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';

export type LiveEventListener = (event: LiveEvent) => void;

/**
 * The live events of the workspaces with open streams (guide step 4.10). One Redis connection
 * per API process subscribes to the channel of a workspace while a stream of it is open and hands
 * each event to its streams. ioredis subscribes again after a lost connection.
 */
@Injectable()
export class LiveEventHub implements OnApplicationShutdown {
  private readonly logger = new Logger(LiveEventHub.name);
  private readonly listeners = new Map<string, Set<LiveEventListener>>();
  private subscriber: Redis | null = null;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  /** Starts listening to the workspace; the returned function stops it again and never throws. */
  async subscribe(workspaceId: string, listener: LiveEventListener): Promise<() => Promise<void>> {
    const channel = liveEventChannel(workspaceId);
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
      try {
        await this.connection().subscribe(channel);
      } catch (error) {
        this.listeners.delete(channel);
        throw error;
      }
    }
    listeners.add(listener);
    const own = listeners;
    return async () => {
      own.delete(listener);
      if (own.size === 0 && this.listeners.get(channel) === own) {
        this.listeners.delete(channel);
        await this.connection()
          .unsubscribe(channel)
          .catch((error: unknown) => {
            this.logger.warn({ err: error }, 'live.unsubscribe_failed');
          });
      }
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }

  private connection(): Redis {
    if (!this.subscriber) {
      const subscriber = new Redis(this.env.REDIS_URL, { lazyConnect: true });
      subscriber.on('message', (channel: string, message: string) => {
        this.dispatch(channel, message);
      });
      subscriber.on('error', (error: unknown) => {
        this.logger.warn({ err: error }, 'live.redis_error');
      });
      this.subscriber = subscriber;
    }
    return this.subscriber;
  }

  private dispatch(channel: string, message: string): void {
    const listeners = this.listeners.get(channel);
    if (!listeners) {
      return;
    }
    let event: LiveEvent;
    try {
      event = parseLiveEvent(JSON.parse(message));
    } catch {
      this.logger.warn({ channel }, 'live.invalid_event');
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }
}
