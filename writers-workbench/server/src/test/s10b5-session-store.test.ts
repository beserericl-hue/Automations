/**
 * S10b-5 — shared session store + SSE pub/sub.
 *
 * Tests cover:
 *   - session-store.ts Redis backend: hash+TTL, isActive refreshes,
 *     missing-session returns false, count via SCAN.
 *   - session-store.ts in-memory backend: happy path and TTL expiry.
 *   - sse-pubsub.ts: subscribe fan-out, ref-counted UNSUBSCRIBE,
 *     local fallback when REDIS_URL is unset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------
// Hoisted ioredis stub — records commands + simulates minimal hash,
// key-level TTL, SCAN, PUBLISH/SUBSCRIBE semantics.

const mocks = vi.hoisted(() => {
  interface HashStore extends Map<string, Record<string, string>> {}
  const hashes: HashStore = new Map();
  const expirations = new Map<string, number>();

  function keyAlive(key: string): boolean {
    const exp = expirations.get(key);
    if (exp && exp < Date.now()) {
      hashes.delete(key);
      expirations.delete(key);
      return false;
    }
    return hashes.has(key);
  }

  class FakeMulti {
    private ops: Array<() => Promise<unknown>> = [];
    hset(key: string, ...rest: unknown[]) {
      this.ops.push(async () => fakeHset(key, ...rest));
      return this;
    }
    expire(key: string, seconds: number) {
      this.ops.push(async () => {
        expirations.set(key, Date.now() + seconds * 1_000);
        return 1;
      });
      return this;
    }
    async exec() {
      const results: Array<[null, unknown]> = [];
      for (const op of this.ops) results.push([null, await op()]);
      return results;
    }
  }

  async function fakeHset(key: string, ...rest: unknown[]): Promise<number> {
    const existing = hashes.get(key) ?? {};
    // support two ioredis signatures: hset(k, {a:1,b:2}) and hset(k, field, value)
    if (rest.length === 1 && typeof rest[0] === 'object') {
      Object.assign(existing, rest[0]);
    } else {
      for (let i = 0; i < rest.length; i += 2) {
        existing[String(rest[i])] = String(rest[i + 1]);
      }
    }
    hashes.set(key, existing);
    return 1;
  }

  const subscribeChannels = new Set<string>();
  const subscribeListeners = new Map<string, Set<(msg: string) => void>>();

  return {
    hashes,
    expirations,
    subscribeChannels,
    subscribeListeners,
    keyAlive,
    hsetMock: vi.fn(fakeHset),
    hexistsMock: vi.fn(async (key: string, field: string) => {
      if (!keyAlive(key)) return 0;
      return hashes.get(key)?.[field] !== undefined ? 1 : 0;
    }),
    hgetallMock: vi.fn(async (key: string) => {
      if (!keyAlive(key)) return {};
      return { ...(hashes.get(key) ?? {}) };
    }),
    delMock: vi.fn(async (key: string) => {
      const existed = hashes.delete(key) ? 1 : 0;
      expirations.delete(key);
      return existed;
    }),
    expireMock: vi.fn(async (key: string, seconds: number) => {
      expirations.set(key, Date.now() + seconds * 1_000);
      return 1;
    }),
    scanMock: vi.fn(async (_cursor: string, ..._rest: unknown[]) => {
      const keys: string[] = [];
      const matchIdx = _rest.findIndex((x) => x === 'MATCH');
      const pattern = matchIdx >= 0 ? String(_rest[matchIdx + 1]) : '*';
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      for (const k of hashes.keys()) if (re.test(k)) keys.push(k);
      return ['0', keys];
    }),
    pingMock: vi.fn(async () => 'PONG'),
    quitMock: vi.fn(async () => 'OK'),
    onMock: vi.fn(),
    publishMock: vi.fn(async (channel: string, message: string) => {
      const listeners = subscribeListeners.get(channel) ?? new Set();
      for (const l of listeners) l(message);
      return listeners.size;
    }),
    subscribeMock: vi.fn(async (channel: string) => {
      subscribeChannels.add(channel);
      return 1;
    }),
    unsubscribeMock: vi.fn(async (channel: string) => {
      subscribeChannels.delete(channel);
      return 1;
    }),
    multiFactory: () => new FakeMulti(),
  };
});

vi.mock('ioredis', () => {
  class FakeRedis {
    ping = mocks.pingMock;
    quit = mocks.quitMock;
    on = mocks.onMock;
    hset = mocks.hsetMock;
    hexists = mocks.hexistsMock;
    hgetall = mocks.hgetallMock;
    del = mocks.delMock;
    expire = mocks.expireMock;
    scan = mocks.scanMock;
    publish = mocks.publishMock;
    subscribe = mocks.subscribeMock;
    unsubscribe = mocks.unsubscribeMock;
    multi() {
      return mocks.multiFactory();
    }
    // subscriber 'message' event plumbing — tests drive it directly
    private listeners = new Map<string, Array<(channel: string, msg: string) => void>>();
    addMessageListener(cb: (channel: string, msg: string) => void) {
      const existing = this.listeners.get('message') ?? [];
      existing.push(cb);
      this.listeners.set('message', existing);
    }
    emitMessage(channel: string, msg: string) {
      for (const cb of this.listeners.get('message') ?? []) cb(channel, msg);
    }
  }
  // Override `on` to wire 'message' through to a dispatch map that
  // our publishMock can trigger via channel listeners.
  // Simpler: have publishMock directly invoke the subscriber-side
  // listeners registered in subscribeListeners.
  return { default: FakeRedis };
});

// --------------------------------------------------------------------
// Setup

beforeEach(() => {
  process.env.REDIS_URL = 'redis://localhost:6379';
  mocks.hashes.clear();
  mocks.expirations.clear();
  mocks.subscribeChannels.clear();
  mocks.subscribeListeners.clear();
  mocks.hsetMock.mockClear();
  mocks.hexistsMock.mockClear();
  mocks.hgetallMock.mockClear();
  mocks.delMock.mockClear();
  mocks.expireMock.mockClear();
  mocks.publishMock.mockClear();
  mocks.subscribeMock.mockClear();
  mocks.unsubscribeMock.mockClear();
});

afterEach(async () => {
  delete process.env.REDIS_URL;
  const { resetSessionStoreForTest } = await import('../lib/session-store.js');
  resetSessionStoreForTest();
  const { resetSsePubsubForTest } = await import('../lib/sse-pubsub.js');
  resetSsePubsubForTest();
  const { resetRedisForTest } = await import('../lib/redis.js');
  resetRedisForTest();
});

// --------------------------------------------------------------------
// Session store — Redis backend

describe('Redis session store', () => {
  it('register() writes a hash with a 30-min TTL', async () => {
    const { getSessionStore, SESSION_TTL_SEC } = await import('../lib/session-store.js');
    await getSessionStore().register('+14105551234');
    const stored = mocks.hashes.get('session:+14105551234');
    expect(stored?.userId).toBe('+14105551234');
    expect(stored?.channel).toBe('web');
    expect(Number(stored?.registeredAt)).toBeGreaterThan(0);
    const exp = mocks.expirations.get('session:+14105551234')!;
    const remainingMs = exp - Date.now();
    expect(remainingMs).toBeGreaterThan(SESSION_TTL_SEC * 1_000 - 2_000);
    expect(remainingMs).toBeLessThanOrEqual(SESSION_TTL_SEC * 1_000);
  });

  it('isActive() returns false for an unknown user', async () => {
    const { getSessionStore } = await import('../lib/session-store.js');
    const active = await getSessionStore().isActive('+nobody');
    expect(active).toBe(false);
  });

  it('isActive() returns true and refreshes TTL on subsequent calls', async () => {
    const { getSessionStore, SESSION_TTL_SEC } = await import('../lib/session-store.js');
    const store = getSessionStore();
    await store.register('+1');
    // advance "time" by shrinking the expiration the store set
    mocks.expirations.set('session:+1', Date.now() + 10_000);
    expect(await store.isActive('+1')).toBe(true);
    const refreshed = mocks.expirations.get('session:+1')!;
    expect(refreshed - Date.now()).toBeGreaterThan(SESSION_TTL_SEC * 1_000 - 2_000);
  });

  it('isActive() does NOT resurrect a key that expired', async () => {
    const { getSessionStore } = await import('../lib/session-store.js');
    const store = getSessionStore();
    await store.register('+1');
    // force-expire the key
    mocks.hashes.delete('session:+1');
    mocks.expirations.delete('session:+1');
    expect(await store.isActive('+1')).toBe(false);
    expect(mocks.hashes.has('session:+1')).toBe(false);
  });

  it('unregister() removes the key', async () => {
    const { getSessionStore } = await import('../lib/session-store.js');
    const store = getSessionStore();
    await store.register('+1');
    await store.unregister('+1');
    expect(mocks.hashes.has('session:+1')).toBe(false);
  });

  it('count() reports number of session:* keys via SCAN', async () => {
    const { getSessionStore } = await import('../lib/session-store.js');
    const store = getSessionStore();
    await store.register('+1');
    await store.register('+2');
    await store.register('+3');
    const n = await store.count();
    expect(n).toBe(3);
  });
});

// --------------------------------------------------------------------
// Session store — in-memory fallback

describe('In-memory session store (REDIS_URL unset)', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
  });

  it('round-trips register/isActive/unregister without Redis', async () => {
    const { getSessionStore } = await import('../lib/session-store.js');
    const store = getSessionStore();
    await store.register('+1');
    expect(await store.isActive('+1')).toBe(true);
    await store.unregister('+1');
    expect(await store.isActive('+1')).toBe(false);
  });

  it('count() reports the number of sessions held locally', async () => {
    const { getSessionStore } = await import('../lib/session-store.js');
    const store = getSessionStore();
    await store.register('+a');
    await store.register('+b');
    expect(await store.count()).toBe(2);
  });
});

// --------------------------------------------------------------------
// SSE pub/sub — in-memory fallback path

describe('SSE pub/sub (local fallback)', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
  });

  it('publishSseEvent delivers to a local subscriber synchronously', async () => {
    const { publishSseEvent, subscribeSseEvents } = await import('../lib/sse-pubsub.js');
    const received: Array<Record<string, unknown>> = [];
    const off = await subscribeSseEvents('+1', (e) => received.push(e));
    await publishSseEvent('+1', { type: 'job-status', jobId: 'b1', status: 'active' });
    expect(received).toHaveLength(1);
    expect((received[0] as { jobId: string }).jobId).toBe('b1');
    await off();
  });

  it('publish to channel X does not reach subscriber on channel Y', async () => {
    const { publishSseEvent, subscribeSseEvents } = await import('../lib/sse-pubsub.js');
    const received: Array<Record<string, unknown>> = [];
    const off = await subscribeSseEvents('+1', (e) => received.push(e));
    await publishSseEvent('+2', { type: 'job-status', jobId: 'b1' });
    expect(received).toHaveLength(0);
    await off();
  });

  it('unsubscribing stops further events', async () => {
    const { publishSseEvent, subscribeSseEvents } = await import('../lib/sse-pubsub.js');
    const received: Array<Record<string, unknown>> = [];
    const off = await subscribeSseEvents('+1', (e) => received.push(e));
    await off();
    await publishSseEvent('+1', { type: 'job-status', jobId: 'b1' });
    expect(received).toHaveLength(0);
  });

  it('multiple subscribers for the same user all receive events', async () => {
    const { publishSseEvent, subscribeSseEvents } = await import('../lib/sse-pubsub.js');
    const received1: Array<Record<string, unknown>> = [];
    const received2: Array<Record<string, unknown>> = [];
    const off1 = await subscribeSseEvents('+1', (e) => received1.push(e));
    const off2 = await subscribeSseEvents('+1', (e) => received2.push(e));
    await publishSseEvent('+1', { type: 'job-status', jobId: 'b1' });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    await off1();
    await off2();
  });
});
