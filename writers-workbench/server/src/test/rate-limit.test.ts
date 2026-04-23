/**
 * S11-4 — Per-user rate limiter (lib/rate-limit.ts).
 *
 * Exercises both the Redis and in-memory implementations. The Redis
 * side runs against a hoisted fake ioredis client so we can assert
 * atomic MULTI/INCR/EXPIRE behavior without a real Redis.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  pingMock: vi.fn(),
  quitMock: vi.fn(),
  onMock: vi.fn(),
  // Shared counter map so MULTI.incr + MULTI.ttl return consistent values.
  keyCounts: new Map<string, number>(),
  keyExpires: new Map<string, number>(), // stored as seconds-until-expiry
  multiBuilder: vi.fn(),
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    ping = mocks.pingMock;
    quit = mocks.quitMock;
    on = mocks.onMock;
    multi = () => {
      const ops: Array<() => Promise<unknown>> = [];
      const chain = {
        incr: (key: string) => {
          ops.push(async () => {
            const current = mocks.keyCounts.get(key) ?? 0;
            const next = current + 1;
            mocks.keyCounts.set(key, next);
            return next;
          });
          return chain;
        },
        expire: (key: string, seconds: number, flag?: string) => {
          ops.push(async () => {
            if (flag === 'NX') {
              // Only set TTL if we haven't set one yet for this key
              if (!mocks.keyExpires.has(key)) {
                mocks.keyExpires.set(key, seconds);
                return 1;
              }
              return 0;
            }
            mocks.keyExpires.set(key, seconds);
            return 1;
          });
          return chain;
        },
        ttl: (key: string) => {
          ops.push(async () => mocks.keyExpires.get(key) ?? -1);
          return chain;
        },
        exec: async () => {
          const results: Array<[Error | null, unknown]> = [];
          for (const op of ops) {
            try {
              results.push([null, await op()]);
            } catch (err) {
              results.push([err as Error, null]);
            }
          }
          return results;
        },
      };
      mocks.multiBuilder(chain);
      return chain;
    };
  }
  return { default: FakeRedis };
});

beforeEach(() => {
  mocks.keyCounts.clear();
  mocks.keyExpires.clear();
  mocks.pingMock.mockReset();
  mocks.quitMock.mockReset();
});

afterEach(async () => {
  const mod = await import('../lib/rate-limit.js');
  mod.resetEmailRateLimiterForTest();
  delete process.env.REDIS_URL;
});

// --------------------------------------------------------------------
// In-memory path

describe('In-memory rate limiter (REDIS_URL unset)', () => {
  it('allows the first 30 calls and rejects the 31st with a retryAfter', async () => {
    delete process.env.REDIS_URL;
    const { getEmailRateLimiter } = await import('../lib/rate-limit.js');
    const rl = getEmailRateLimiter();
    for (let i = 0; i < 30; i++) {
      const r = await rl.checkAndIncr('user-A');
      expect(r.ok).toBe(true);
    }
    const r31 = await rl.checkAndIncr('user-A');
    expect(r31.ok).toBe(false);
    if (!r31.ok) {
      expect(r31.retryAfter).toBeGreaterThan(0);
      expect(r31.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it('different keys have independent quotas', async () => {
    delete process.env.REDIS_URL;
    const { getEmailRateLimiter } = await import('../lib/rate-limit.js');
    const rl = getEmailRateLimiter();
    for (let i = 0; i < 30; i++) await rl.checkAndIncr('user-B');
    expect((await rl.checkAndIncr('user-B')).ok).toBe(false);
    // user-C still has full quota
    expect((await rl.checkAndIncr('user-C')).ok).toBe(true);
  });
});

// --------------------------------------------------------------------
// Redis path

describe('Redis rate limiter (REDIS_URL set)', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  it('allows the first 30 calls and rejects the 31st', async () => {
    const { getEmailRateLimiter } = await import('../lib/rate-limit.js');
    const rl = getEmailRateLimiter();
    for (let i = 0; i < 30; i++) {
      const r = await rl.checkAndIncr('user-R');
      expect(r.ok).toBe(true);
    }
    const r31 = await rl.checkAndIncr('user-R');
    expect(r31.ok).toBe(false);
    if (!r31.ok) {
      expect(r31.retryAfter).toBeGreaterThan(0);
    }
  });

  it('uses the email prefix on the Redis key', async () => {
    const { getEmailRateLimiter } = await import('../lib/rate-limit.js');
    const rl = getEmailRateLimiter();
    await rl.checkAndIncr('user-X');
    // Check that the counter is stored under "rl:email:user-X"
    expect(mocks.keyCounts.get('rl:email:user-X')).toBe(1);
  });

  it('sets TTL only on first increment (via NX semantics)', async () => {
    const { getEmailRateLimiter } = await import('../lib/rate-limit.js');
    const rl = getEmailRateLimiter();
    await rl.checkAndIncr('user-Y');
    const ttl1 = mocks.keyExpires.get('rl:email:user-Y');
    expect(ttl1).toBe(60);
    // Second call should not change the TTL (NX in our fake)
    await rl.checkAndIncr('user-Y');
    const ttl2 = mocks.keyExpires.get('rl:email:user-Y');
    expect(ttl2).toBe(60);
  });

  it('fails open if Redis throws (rate limit is not a security boundary)', async () => {
    const { getEmailRateLimiter } = await import('../lib/rate-limit.js');
    // Force the multi chain to throw on exec
    mocks.multiBuilder.mockImplementationOnce((chain: { exec: () => Promise<unknown> }) => {
      chain.exec = async () => {
        throw new Error('ECONNRESET');
      };
    });
    const rl = getEmailRateLimiter();
    const r = await rl.checkAndIncr('any-user');
    expect(r.ok).toBe(true);
  });

  it('different users do not share the Redis counter', async () => {
    const { getEmailRateLimiter } = await import('../lib/rate-limit.js');
    const rl = getEmailRateLimiter();
    for (let i = 0; i < 30; i++) await rl.checkAndIncr('user-D');
    expect((await rl.checkAndIncr('user-D')).ok).toBe(false);
    expect((await rl.checkAndIncr('user-E')).ok).toBe(true);
  });

  it('two limiter instances sharing the same Redis respect a shared quota (horizontal scale)', async () => {
    // Simulates two Express instances: both get their own limiter from
    // the factory, but since REDIS_URL points at the same (fake) Redis
    // and the counter is server-side, the 31st combined call gets 429.
    const { getEmailRateLimiter, resetEmailRateLimiterForTest } = await import(
      '../lib/rate-limit.js'
    );
    const rl1 = getEmailRateLimiter();

    // Simulate second instance: reset singleton and fetch fresh
    resetEmailRateLimiterForTest();
    const rl2 = getEmailRateLimiter();

    // Interleave: 20 calls through rl1, 10 through rl2 → 30 total → 31st any instance = 429
    for (let i = 0; i < 20; i++) expect((await rl1.checkAndIncr('user-S')).ok).toBe(true);
    for (let i = 0; i < 10; i++) expect((await rl2.checkAndIncr('user-S')).ok).toBe(true);
    expect((await rl1.checkAndIncr('user-S')).ok).toBe(false);
    expect((await rl2.checkAndIncr('user-S')).ok).toBe(false);
  });
});
