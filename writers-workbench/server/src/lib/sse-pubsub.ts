/**
 * S10b-5: SSE fan-out via Redis pub/sub.
 *
 * Before this change, SSE clients were held in a per-instance array and
 * events were written directly to the matching `res` stream. That works
 * on one Express instance but breaks the moment a second instance is
 * added — a job finishing on instance A had no way to reach an SSE
 * client connected to instance B.
 *
 * Now:
 *   - `publishSseEvent(userId, event)` PUBLISHes to channel `sse:{userId}`
 *     via the main Redis connection.
 *   - `subscribeSseEvents(userId, handler)` attaches a local handler and
 *     (on first subscriber) tells the dedicated subscriber connection
 *     to SUBSCRIBE. When the last local subscriber unsubscribes, the
 *     Redis-level SUBSCRIBE is dropped too.
 *
 * IORedis flips the subscriber client into "subscriber mode" as soon as
 * SUBSCRIBE is called — that client cannot issue other commands. We
 * keep a dedicated second connection for it and leave the main
 * connection free for PUBLISH + session-store ops.
 *
 * No-Redis fallback uses an in-process EventEmitter so local dev still
 * works without a running Redis.
 */

import IORedis, { type Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { logger } from './logger.js';
import { getRedis } from './redis.js';

export type SseHandler = (event: Record<string, unknown>) => void;

function channelFor(userId: string): string {
  return `sse:${userId}`;
}

// --------------------------------------------------------------------
// Redis-backed path (shared state across Express instances)

let subscriber: Redis | null = null;
const channelHandlers = new Map<string, Set<SseHandler>>();

function getSubscriber(): Redis {
  if (subscriber) return subscriber;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required for Redis SSE pub/sub');

  subscriber = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  subscriber.on('message', (channel, message) => {
    const handlers = channelHandlers.get(channel);
    if (!handlers || handlers.size === 0) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      logger.warn({ err, channel }, 'sse-pubsub: bad JSON on channel');
      return;
    }
    for (const h of handlers) {
      try {
        h(parsed);
      } catch (err) {
        logger.error({ err, channel }, 'sse-pubsub: handler threw');
      }
    }
  });

  subscriber.on('error', (err) => logger.error({ err }, 'sse-pubsub subscriber: error'));
  subscriber.on('connect', () => logger.info('sse-pubsub subscriber: connect'));
  return subscriber;
}

async function redisPublish(userId: string, event: Record<string, unknown>): Promise<void> {
  const r = getRedis();
  await r.publish(channelFor(userId), JSON.stringify(event));
}

async function redisSubscribe(userId: string, handler: SseHandler): Promise<() => Promise<void>> {
  const channel = channelFor(userId);
  const sub = getSubscriber();
  let handlers = channelHandlers.get(channel);
  if (!handlers) {
    handlers = new Set();
    channelHandlers.set(channel, handlers);
    await sub.subscribe(channel);
  }
  handlers.add(handler);

  return async () => {
    const current = channelHandlers.get(channel);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      channelHandlers.delete(channel);
      try {
        await sub.unsubscribe(channel);
      } catch (err) {
        logger.error({ err, channel }, 'sse-pubsub: unsubscribe failed');
      }
    }
  };
}

// --------------------------------------------------------------------
// In-process fallback (single instance, no Redis)

const localEmitter = new EventEmitter();
// Event loops can accumulate many SSE clients for the same user; raise
// the default 10-listener warning threshold.
localEmitter.setMaxListeners(1000);

function localPublish(userId: string, event: Record<string, unknown>): void {
  localEmitter.emit(channelFor(userId), event);
}

function localSubscribe(userId: string, handler: SseHandler): () => void {
  const ch = channelFor(userId);
  localEmitter.on(ch, handler);
  return () => localEmitter.off(ch, handler);
}

// --------------------------------------------------------------------
// Public API — picks Redis when REDIS_URL is set, else in-memory.

export async function publishSseEvent(
  userId: string,
  event: Record<string, unknown>,
): Promise<number> {
  if (process.env.REDIS_URL) {
    try {
      await redisPublish(userId, event);
      return 1;
    } catch (err) {
      logger.error({ err, userId }, 'sse-pubsub: publish failed');
      return 0;
    }
  }
  localPublish(userId, event);
  return 1;
}

export async function subscribeSseEvents(
  userId: string,
  handler: SseHandler,
): Promise<() => Promise<void>> {
  if (process.env.REDIS_URL) {
    return redisSubscribe(userId, handler);
  }
  const off = localSubscribe(userId, handler);
  return async () => off();
}

export async function closeSsePubsub(): Promise<void> {
  if (!subscriber) return;
  try {
    channelHandlers.clear();
    await subscriber.quit();
  } catch (err) {
    logger.error({ err }, 'sse-pubsub: close failed');
  } finally {
    subscriber = null;
  }
}

export function resetSsePubsubForTest(): void {
  subscriber = null;
  channelHandlers.clear();
  localEmitter.removeAllListeners();
}
