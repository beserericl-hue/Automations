import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.hoisted so these exist before vi.mock factories run (which are hoisted to top of file)
const mocks = vi.hoisted(() => {
  return {
    pingMock: vi.fn(),
    quitMock: vi.fn(),
    onMock: vi.fn(),
    disconnectMock: vi.fn(),
    queueCloseMock: vi.fn(),
  };
});

vi.mock('ioredis', () => {
  class FakeIORedis {
    ping = mocks.pingMock;
    quit = mocks.quitMock;
    disconnect = mocks.disconnectMock;
    on = mocks.onMock;
  }
  return { default: FakeIORedis };
});

vi.mock('bullmq', () => {
  class FakeQueue {
    name: string;
    opts: unknown;
    close = mocks.queueCloseMock;
    constructor(name: string, opts: unknown) {
      this.name = name;
      this.opts = opts;
    }
  }
  return { Queue: FakeQueue };
});

// Convenience aliases
const { pingMock, quitMock, onMock, disconnectMock, queueCloseMock } = mocks;

describe('redis factory', () => {
  beforeEach(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    pingMock.mockReset().mockResolvedValue('PONG');
    quitMock.mockReset().mockResolvedValue('OK');
    onMock.mockReset();
    disconnectMock.mockReset();
    const redisMod = await import('../lib/redis.js');
    redisMod.resetRedisForTest();
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  it('getRedis() returns an IORedis client with event handlers attached', async () => {
    const { getRedis } = await import('../lib/redis.js');
    const client = getRedis();
    expect(client).toBeDefined();
    // connect / ready / error / close / reconnecting
    expect(onMock).toHaveBeenCalledTimes(5);
    const events = onMock.mock.calls.map((c) => c[0]);
    expect(events).toEqual(['connect', 'ready', 'error', 'close', 'reconnecting']);
  });

  it('getRedis() reuses the same connection on subsequent calls', async () => {
    const { getRedis } = await import('../lib/redis.js');
    const a = getRedis();
    const b = getRedis();
    expect(a).toBe(b);
  });

  it('getRedis() throws when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const { getRedis } = await import('../lib/redis.js');
    expect(() => getRedis()).toThrow(/REDIS_URL/);
  });

  it('redisHealthy() returns true on PONG', async () => {
    const { redisHealthy } = await import('../lib/redis.js');
    await expect(redisHealthy()).resolves.toBe(true);
    expect(pingMock).toHaveBeenCalled();
  });

  it('redisHealthy() returns false when ping throws', async () => {
    pingMock.mockRejectedValueOnce(new Error('boom'));
    const { redisHealthy } = await import('../lib/redis.js');
    await expect(redisHealthy()).resolves.toBe(false);
  });

  it('redisHealthy() returns false when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const { redisHealthy } = await import('../lib/redis.js');
    await expect(redisHealthy()).resolves.toBe(false);
  });

  it('closeRedis() calls quit()', async () => {
    const { getRedis, closeRedis } = await import('../lib/redis.js');
    getRedis();
    await closeRedis();
    expect(quitMock).toHaveBeenCalled();
  });
});

describe('queue factory', () => {
  beforeEach(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    pingMock.mockReset().mockResolvedValue('PONG');
    quitMock.mockReset().mockResolvedValue('OK');
    onMock.mockReset();
    queueCloseMock.mockReset().mockResolvedValue(undefined);
    const redisMod = await import('../lib/redis.js');
    redisMod.resetRedisForTest();
    const q = await import('../lib/queue.js');
    q.resetQueueRegistryForTest();
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  it('createQueue() returns a Queue with the name we gave it', async () => {
    const { createQueue } = await import('../lib/queue.js');
    const q = createQueue('chat') as unknown as { name: string };
    expect(q.name).toBe('chat');
  });

  it('createQueue() applies default retry/backoff options', async () => {
    const { createQueue } = await import('../lib/queue.js');
    const q = createQueue('email') as unknown as {
      opts: { defaultJobOptions: { attempts: number; backoff: { type: string; delay: number } } };
    };
    expect(q.opts.defaultJobOptions.attempts).toBe(3);
    expect(q.opts.defaultJobOptions.backoff).toEqual({ type: 'exponential', delay: 1_000 });
  });

  it('createQueue() is a registry — same name returns same instance', async () => {
    const { createQueue } = await import('../lib/queue.js');
    const a = createQueue('work');
    const b = createQueue('work');
    expect(a).toBe(b);
  });

  it('closeAllQueues() closes every registered queue', async () => {
    const { createQueue, closeAllQueues } = await import('../lib/queue.js');
    createQueue('q1');
    createQueue('q2');
    createQueue('q3');
    await closeAllQueues();
    expect(queueCloseMock).toHaveBeenCalledTimes(3);
  });

  it('closeAllQueues() empties the registry after close', async () => {
    const { createQueue, closeAllQueues, getRegisteredQueues } = await import('../lib/queue.js');
    createQueue('q1');
    await closeAllQueues();
    expect(getRegisteredQueues()).toHaveLength(0);
  });
});
