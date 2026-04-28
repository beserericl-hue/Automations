/**
 * S10b-5: Shared session store.
 *
 * Before this change, web sessions lived in a single in-process Map on
 * each Express instance. With horizontal scaling that falls apart —
 * one instance sees a session the next request could be routed to
 * another instance that doesn't. This module moves the store into
 * Redis (hash-per-user, key-level TTL) so any instance can observe
 * the same truth.
 *
 * For local development and tests we keep an in-memory fallback so
 * developers don't need Redis up to run a dev server.
 */

import { getRedis } from './redis.js';
import { logger } from './logger.js';

export const SESSION_TTL_SEC = 30 * 60;
const KEY_PREFIX = 'session:';

export interface WebSession {
  userId: string;
  channel: 'web';
  registeredAt: number;
  lastActivity: number;
}

export interface SessionStore {
  register(userId: string): Promise<void>;
  unregister(userId: string): Promise<void>;
  get(userId: string): Promise<WebSession | null>;
  /** True if the session exists and is within TTL; refreshes lastActivity as a side effect. */
  isActive(userId: string): Promise<boolean>;
  /** Rough active-session count for /api/health. */
  count(): Promise<number>;
}

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

// --------------------------------------------------------------------
// Redis-backed store (production / shared state)

class RedisSessionStore implements SessionStore {
  async register(userId: string): Promise<void> {
    const now = Date.now();
    const k = keyFor(userId);
    const r = getRedis();
    await r
      .multi()
      .hset(k, {
        userId,
        channel: 'web',
        registeredAt: String(now),
        lastActivity: String(now),
      })
      .expire(k, SESSION_TTL_SEC)
      .exec();
  }

  async unregister(userId: string): Promise<void> {
    await getRedis().del(keyFor(userId));
  }

  async get(userId: string): Promise<WebSession | null> {
    const raw = await getRedis().hgetall(keyFor(userId));
    if (!raw || !raw.userId) return null;
    return {
      userId: raw.userId,
      channel: 'web',
      registeredAt: Number(raw.registeredAt) || 0,
      lastActivity: Number(raw.lastActivity) || 0,
    };
  }

  async isActive(userId: string): Promise<boolean> {
    const k = keyFor(userId);
    const r = getRedis();
    // HEXISTS first so a refresh doesn't resurrect an expired session.
    const exists = await r.hexists(k, 'userId');
    if (!exists) return false;
    // Key-level TTL is refreshed on every activity check so sessions
    // only disappear after 30 min of silence.
    await r
      .multi()
      .hset(k, 'lastActivity', String(Date.now()))
      .expire(k, SESSION_TTL_SEC)
      .exec();
    return true;
  }

  async count(): Promise<number> {
    let cursor = '0';
    let n = 0;
    const r = getRedis();
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
      n += keys.length;
      cursor = next;
    } while (cursor !== '0');
    return n;
  }
}

// --------------------------------------------------------------------
// In-memory fallback (local dev + tests without Redis)

class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, WebSession>();
  private timeoutMs = SESSION_TTL_SEC * 1_000;

  async register(userId: string): Promise<void> {
    const now = Date.now();
    this.sessions.set(userId, {
      userId,
      channel: 'web',
      registeredAt: now,
      lastActivity: now,
    });
  }

  async unregister(userId: string): Promise<void> {
    this.sessions.delete(userId);
  }

  async get(userId: string): Promise<WebSession | null> {
    const s = this.sessions.get(userId);
    if (!s) return null;
    if (Date.now() - s.lastActivity > this.timeoutMs) {
      this.sessions.delete(userId);
      return null;
    }
    return { ...s };
  }

  async isActive(userId: string): Promise<boolean> {
    const s = this.sessions.get(userId);
    if (!s) return false;
    if (Date.now() - s.lastActivity > this.timeoutMs) {
      this.sessions.delete(userId);
      return false;
    }
    s.lastActivity = Date.now();
    return true;
  }

  async count(): Promise<number> {
    return this.sessions.size;
  }
}

// --------------------------------------------------------------------
// Factory — one store per process, Redis when available else in-memory

let _store: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (_store) return _store;
  if (process.env.REDIS_URL) {
    _store = new RedisSessionStore();
    logger.info('session-store: using Redis');
  } else {
    _store = new InMemorySessionStore();
    logger.info('session-store: using in-memory fallback (REDIS_URL unset)');
  }
  return _store;
}

export function resetSessionStoreForTest(): void {
  _store = null;
}
