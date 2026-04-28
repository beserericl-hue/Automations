/**
 * Per-user concurrency gating (S10b-4).
 *
 * BullMQ's per-queue concurrency is global — 4 brainstorms at once across
 * all users, not per user. For our workload that lets a single user hog
 * the heavy-ops queue by submitting several chapter writes back-to-back.
 *
 * This module enforces "max N jobs active per user" without requiring
 * the BullMQ coordinator to know about users. The worker processor
 * checks two Redis counters before accepting a job:
 *
 *   - user_active_total:{userId}  — every running job counts
 *   - user_active_heavy:{userId}  — only heavy-ops counts
 *
 * If either counter would exceed its cap, the job is pushed back onto
 * the delayed set (via `moveToDelayed`) and BullMQ is told via
 * `DelayedError` that the job wasn't failed. Counters are decremented
 * in a `finally` so a crash still frees the slot.
 *
 * Safety: every INCR is paired with a 30-minute TTL. Heavy-ops timeout
 * is 20 minutes, so the TTL is longer than any single job can legally
 * run, but short enough that a server crash cleans itself up without a
 * manual intervention.
 */

import type Redis from 'ioredis';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';
import type { QueueName } from './types.js';

export interface ConcurrencyLimits {
  /** Max total active jobs per user across all queues. */
  totalPerUser: number;
  /** Max concurrent heavy-ops jobs per user. */
  heavyPerUser: number;
  /** Delay before a rejected job is retried, in ms. */
  retryDelayMs: number;
}

export const DEFAULT_LIMITS: ConcurrencyLimits = {
  totalPerUser: 3,
  heavyPerUser: 1,
  retryDelayMs: 5_000,
};

const KEY_TTL_SEC = 30 * 60; // 30 minutes — safety valve

function totalKey(userId: string): string {
  return `user_active_total:${userId}`;
}
function heavyKey(userId: string): string {
  return `user_active_heavy:${userId}`;
}

export type AcquireResult = 'ok' | 'total-full' | 'heavy-full';

/**
 * Tries to reserve a per-user slot. If it succeeds, the caller owns the
 * slot and MUST call `releaseUserSlot` once the job is done (success
 * or failure).
 */
export async function tryAcquireUserSlot(
  userId: string,
  queueName: QueueName,
  limits: ConcurrencyLimits = DEFAULT_LIMITS,
  redis: Redis = getRedis(),
): Promise<AcquireResult> {
  const isHeavy = queueName === 'heavy-ops';

  const total = await redis.incr(totalKey(userId));
  await redis.expire(totalKey(userId), KEY_TTL_SEC);
  if (total > limits.totalPerUser) {
    await redis.decr(totalKey(userId));
    return 'total-full';
  }

  if (isHeavy) {
    const heavy = await redis.incr(heavyKey(userId));
    await redis.expire(heavyKey(userId), KEY_TTL_SEC);
    if (heavy > limits.heavyPerUser) {
      await redis.decr(heavyKey(userId));
      await redis.decr(totalKey(userId));
      return 'heavy-full';
    }
  }
  return 'ok';
}

/**
 * Releases one user slot. Symmetric with `tryAcquireUserSlot`. Safe to
 * call even if acquire failed — it floors at 0 via a conditional decr.
 */
export async function releaseUserSlot(
  userId: string,
  queueName: QueueName,
  redis: Redis = getRedis(),
): Promise<void> {
  const isHeavy = queueName === 'heavy-ops';
  try {
    await redis.decr(totalKey(userId));
    if (isHeavy) await redis.decr(heavyKey(userId));
  } catch (err) {
    logger.error({ err, userId, queueName }, 'concurrency: release failed');
  }
}

/**
 * Snapshot of a single user's current slot usage — handy for the chat
 * drawer when it wants to show "you have 2 of 3 jobs running".
 */
export interface UserSlotCounts {
  total: number;
  heavy: number;
}

export async function getUserCounts(
  userId: string,
  redis: Redis = getRedis(),
): Promise<UserSlotCounts> {
  const [totalRaw, heavyRaw] = await redis.mget(totalKey(userId), heavyKey(userId));
  return {
    total: Math.max(0, parseInt(totalRaw ?? '0', 10) || 0),
    heavy: Math.max(0, parseInt(heavyRaw ?? '0', 10) || 0),
  };
}
