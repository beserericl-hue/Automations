import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import { logger } from './logger.js';

// BullMQ requires maxRetriesPerRequest: null on the connection it uses.
// Share one connection across app + queues so Railway Redis sees a stable
// client footprint.

let client: Redis | null = null;

function buildOptions(): RedisOptions {
  return {
    // BullMQ blocks forever on some reads and fails if this is set.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Exponential backoff, capped at 10 s, up to 20 attempts before we give up
    retryStrategy: (times) => {
      const delay = Math.min(times * 200, 10_000);
      return delay;
    },
    reconnectOnError: (err) => {
      // Reconnect on READONLY replica errors (Railway Redis primary flip)
      if (err.message.includes('READONLY')) return 2;
      return false;
    },
  };
}

export function getRedis(): Redis {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL env var is required');
  }

  client = new IORedis(url, buildOptions());

  client.on('connect', () => logger.info('redis: connect'));
  client.on('ready', () => logger.info('redis: ready'));
  client.on('error', (err) => logger.error({ err }, 'redis: error'));
  client.on('close', () => logger.warn('redis: close'));
  client.on('reconnecting', (delay: number) =>
    logger.warn({ delay }, 'redis: reconnecting'),
  );

  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch (err) {
    logger.error({ err }, 'redis: quit failed, forcing disconnect');
    client.disconnect();
  }
  client = null;
}

export function resetRedisForTest(): void {
  client = null;
}

export async function redisHealthy(): Promise<boolean> {
  if (!process.env.REDIS_URL) return false;
  try {
    const c = getRedis();
    const pong = await c.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
