import { Queue, type JobsOptions, type QueueOptions } from 'bullmq';
import { getRedis } from './redis.js';
import { logger } from './logger.js';
import { ALL_QUEUE_NAMES, type QueueName } from './jobs/types.js';

// Registry keyed by queue name so we reuse Queue instances across the app
const registry = new Map<string, Queue>();

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1_000,
  },
  // Keep completed/failed records short enough to limit Redis growth; BullMQ
  // rotates automatically when these are set.
  removeOnComplete: { count: 1_000, age: 24 * 3_600 },
  removeOnFail: { count: 5_000, age: 7 * 24 * 3_600 },
};

export function createQueue<TData = unknown, TReturn = unknown>(
  name: string,
  overrides: Partial<QueueOptions> = {},
): Queue<TData, TReturn> {
  const existing = registry.get(name);
  if (existing) return existing as Queue<TData, TReturn>;

  const q = new Queue<TData, TReturn>(name, {
    connection: getRedis(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
    ...overrides,
  });
  registry.set(name, q);
  return q;
}

export function getRegisteredQueues(): Queue[] {
  return Array.from(registry.values());
}

export async function closeAllQueues(): Promise<void> {
  const queues = Array.from(registry.values());
  registry.clear();
  await Promise.all(
    queues.map((q) =>
      q.close().catch((err) => {
        logger.error({ err, queue: q.name }, 'queue: close failed');
      }),
    ),
  );
}

export function resetQueueRegistryForTest(): void {
  registry.clear();
}

/**
 * Returns the named queue for a priority tier. Creates it on first use
 * and reuses it on subsequent calls. Callers should prefer this over
 * createQueue(name) directly so queue names stay consistent with the
 * priority contract in jobs/types.ts.
 */
export function getNamedQueue<TData = unknown, TReturn = unknown>(
  name: QueueName,
): Queue<TData, TReturn> {
  return createQueue<TData, TReturn>(name);
}

/**
 * Eagerly create all four named queues. Useful at boot if we want
 * BullMQ event listeners attached before any jobs land. Idempotent.
 */
export function initAllNamedQueues(): Queue[] {
  return ALL_QUEUE_NAMES.map((name) => createQueue(name));
}
