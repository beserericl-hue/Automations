/**
 * BullMQ Worker that executes N8nWebhookJob jobs — i.e. POSTs the job
 * body to the configured n8n hub webhook and returns the parsed response
 * as the job result.
 *
 * One Worker per queue name. Concurrency + timeout come from
 * QUEUE_SETTINGS in jobs/types.ts. Retries come from the queue's default
 * JobsOptions (3 attempts, exponential backoff, configured in queue.ts).
 *
 * Not wired into the server boot path yet — S10b-3 will start these in
 * index.ts once the chat proxy migrates onto the queue.
 */

import { DelayedError, Worker, type Job, type WorkerOptions } from 'bullmq';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';
import {
  QUEUE_SETTINGS,
  type JobResult,
  type N8nWebhookJob,
  type QueueName,
} from './types.js';
import {
  DEFAULT_LIMITS,
  releaseUserSlot,
  tryAcquireUserSlot,
  type ConcurrencyLimits,
} from './concurrency.js';

/** Thin wrapper so tests can stub the HTTP call. */
export type HttpPost = (
  url: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; body: unknown }>;

const defaultHttpPost: HttpPost = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};

/**
 * Factory: create (but do not start) a Worker bound to a queue name.
 * Export this shape so callers can share mocks across tests.
 */
export function createN8nWorker(
  queueName: QueueName,
  opts: {
    http?: HttpPost;
    workerOptions?: Partial<WorkerOptions>;
    limits?: ConcurrencyLimits;
  } = {},
): Worker<N8nWebhookJob, JobResult> {
  const http = opts.http ?? defaultHttpPost;
  const settings = QUEUE_SETTINGS[queueName];
  const limits = opts.limits ?? DEFAULT_LIMITS;

  const processor = async (
    job: Job<N8nWebhookJob, JobResult>,
    token?: string,
  ): Promise<JobResult> => {
    const { webhookUrl, body, userId } = job.data;

    // S10b-4: per-user concurrency gate. If the user already has N jobs
    // running, push this one to the delayed set and throw DelayedError
    // so BullMQ doesn't count it as a failed attempt.
    // tryAcquireUserSlot already rolls back its own counters on refusal,
    // so we only pair a release when the acquire returned 'ok'.
    const acquired = await tryAcquireUserSlot(userId, queueName, limits);
    if (acquired !== 'ok') {
      logger.info(
        { jobId: job.id, queue: queueName, userId, reason: acquired },
        'n8n-worker: deferring — per-user concurrency limit hit',
      );
      if (token) {
        await job.moveToDelayed(Date.now() + limits.retryDelayMs, token);
      }
      throw new DelayedError();
    }

    const start = Date.now();
    try {
      const { status, body: resp } = await http(webhookUrl, body);

      // Anything 5xx is a retryable failure — throw so BullMQ backs off.
      // Anything 4xx is a permanent failure — still throw, but we return
      // the response body in the error so the caller can inspect.
      if (status >= 500) {
        throw new Error(`n8n webhook 5xx: ${status} ${JSON.stringify(resp)?.slice(0, 200)}`);
      }
      if (status >= 400) {
        return { ok: false, error: `n8n webhook ${status}`, data: resp };
      }
      const durationMs = Date.now() - start;
      logger.info(
        { jobId: job.id, queue: queueName, durationMs, status },
        'n8n-worker: ok',
      );
      return { ok: true, data: resp };
    } catch (err) {
      const durationMs = Date.now() - start;
      logger.error(
        { err, jobId: job.id, queue: queueName, durationMs },
        'n8n-worker: fail',
      );
      throw err; // let BullMQ mark the attempt failed and retry per policy
    } finally {
      // Paired with the 'ok' acquire above — safe because `acquired !== 'ok'`
      // returns via throw before reaching this block.
      await releaseUserSlot(userId, queueName);
    }
  };

  const worker = new Worker<N8nWebhookJob, JobResult>(
    queueName,
    processor,
    {
      connection: getRedis(),
      concurrency: settings.concurrency,
      ...opts.workerOptions,
    },
  );

  worker.on('error', (err) => {
    logger.error({ err, queue: queueName }, 'n8n-worker: runtime error');
  });

  return worker;
}
