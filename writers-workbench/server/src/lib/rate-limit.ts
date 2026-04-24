/**
 * Per-key sliding-window rate limiter.
 *
 * Two implementations:
 *   - RedisRateLimiter   — atomic INCR + EXPIRE; shared across every
 *                          Express instance talking to the same Redis.
 *   - InMemoryRateLimiter — per-process Map. Used for local dev when
 *                          REDIS_URL is unset and as a fallback when
 *                          Redis is temporarily unreachable.
 *
 * Both expose the same shape: checkAndIncr(key) returns either
 * { ok: true } or { ok: false, retryAfter: <seconds> }.
 *
 * The check-and-increment is atomic in the Redis path so two instances
 * racing on the 30th and 31st request for the same user will resolve
 * consistently. In the in-memory path, atomicity is within-process
 * (Node single-threaded) — fine for one instance.
 */

import type Redis from 'ioredis';
import { getRedis } from './redis.js';
import { logger } from './logger.js';

export interface RateLimiter {
  /**
   * Atomically increment the counter for `key`. Returns ok=true if the
   * post-increment count is within the window limit; ok=false with a
   * retry-after when it exceeds.
   */
  checkAndIncr(key: string): Promise<{ ok: true } | { ok: false; retryAfter: number }>;
}

interface LimitConfig {
  /** Max permitted operations per window. */
  limit: number;
  /** Window size in seconds. */
  windowSec: number;
  /** Redis key prefix so multiple limiters coexist (emails, chat, etc.). */
  keyPrefix: string;
}

export const EMAIL_RATE_LIMIT: LimitConfig = {
  limit: 30,
  windowSec: 60,
  keyPrefix: 'rl:email',
};

// --------------------------------------------------------------------
// Redis implementation — fixed-window counter keyed by `<prefix>:<key>`
// with a TTL equal to the window. Atomic via INCR; a single-roundtrip
// pipeline sets the TTL on first increment.

class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly cfg: LimitConfig,
  ) {}

  async checkAndIncr(key: string): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
    const redisKey = `${this.cfg.keyPrefix}:${key}`;
    try {
      const multi = this.redis.multi();
      multi.incr(redisKey);
      // Setting TTL on every call is fine — Redis only extends it if the
      // key was just created (the NX flag). Without NX we'd reset the
      // window on every increment, which is wrong. Use `EXPIRE ... NX`.
      multi.expire(redisKey, this.cfg.windowSec, 'NX');
      multi.ttl(redisKey);
      const res = await multi.exec();
      if (!res) throw new Error('redis.multi.exec returned null');

      const count = res[0][1] as number;
      const ttl = res[2][1] as number;

      if (count <= this.cfg.limit) {
        return { ok: true };
      }

      const retryAfter = ttl > 0 ? ttl : this.cfg.windowSec;
      return { ok: false, retryAfter };
    } catch (err) {
      // Fail open but log loudly. Rate-limiting is not a security boundary —
      // losing it briefly during a Redis hiccup is better than serving 500s.
      logger.error({ err, key }, 'rate-limit: Redis failed, failing open');
      return { ok: true };
    }
  }
}

// --------------------------------------------------------------------
// In-memory implementation — per-process sliding-window Map.

interface InMemWindow {
  count: number;
  windowStart: number;
}

class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, InMemWindow>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly cfg: LimitConfig) {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const windowMs = this.cfg.windowSec * 1000;
      for (const [k, w] of this.windows) {
        if (now - w.windowStart > windowMs * 2) this.windows.delete(k);
      }
    }, 5 * 60_000);
    // Don't block process exit on the cleanup timer
    this.cleanupTimer.unref?.();
  }

  async checkAndIncr(key: string): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
    const now = Date.now();
    const windowMs = this.cfg.windowSec * 1000;
    const existing = this.windows.get(key);
    if (!existing || now - existing.windowStart > windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return { ok: true };
    }
    if (existing.count < this.cfg.limit) {
      existing.count++;
      return { ok: true };
    }
    const retryAfter = Math.ceil((existing.windowStart + windowMs - now) / 1000);
    return { ok: false, retryAfter };
  }

  /** Test-only hook so we can reset state between unit tests. */
  __resetForTest(): void {
    this.windows.clear();
  }
}

// --------------------------------------------------------------------
// Factory — Redis when configured, in-memory fallback otherwise.

let _emailLimiter: RateLimiter | null = null;

export function getEmailRateLimiter(): RateLimiter {
  if (_emailLimiter) return _emailLimiter;
  if (process.env.REDIS_URL) {
    try {
      _emailLimiter = new RedisRateLimiter(getRedis(), EMAIL_RATE_LIMIT);
      logger.info('rate-limit[email]: using Redis');
    } catch (err) {
      logger.warn({ err }, 'rate-limit[email]: Redis unavailable, using in-memory fallback');
      _emailLimiter = new InMemoryRateLimiter(EMAIL_RATE_LIMIT);
    }
  } else {
    _emailLimiter = new InMemoryRateLimiter(EMAIL_RATE_LIMIT);
    logger.info('rate-limit[email]: using in-memory (REDIS_URL unset)');
  }
  return _emailLimiter;
}

export function resetEmailRateLimiterForTest(): void {
  if (_emailLimiter && _emailLimiter instanceof InMemoryRateLimiter) {
    _emailLimiter.__resetForTest();
  }
  _emailLimiter = null;
}
