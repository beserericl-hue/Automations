/**
 * Boot-time wiring for the BullMQ queue layer.
 *
 * - Creates all four named queues.
 * - Starts one n8n-worker per queue to drain N8nWebhookJob jobs.
 * - Attaches the job-tracker (audit → job_queue_v2).
 * - Attaches the SSE forwarder (live status push to the chat drawer).
 *
 * Called from index.ts only if REDIS_URL is configured. Everything here
 * is additive and safe to call once per process — if it's called a
 * second time the queue registry deduplicates, but the workers and
 * QueueEvents listeners would multiply, so guard the caller.
 */

import type { Worker, QueueEvents } from 'bullmq';
import { logger } from '../logger.js';
import { initAllNamedQueues } from '../queue.js';
import { ALL_QUEUE_NAMES } from './types.js';
import { createN8nWorker } from './n8n-worker.js';
import { attachTrackerToQueue } from './job-tracker.js';
import { attachSseForwarderToQueue, type SsePushFn } from './sse-forwarder.js';

export interface JobInfrastructure {
  workers: Worker[];
  trackerEvents: QueueEvents[];
  sseEvents: QueueEvents[];
}

export function startJobInfrastructure(push: SsePushFn): JobInfrastructure {
  initAllNamedQueues();

  const workers: Worker[] = [];
  const trackerEvents: QueueEvents[] = [];
  const sseEvents: QueueEvents[] = [];

  for (const name of ALL_QUEUE_NAMES) {
    workers.push(createN8nWorker(name));
    trackerEvents.push(attachTrackerToQueue(name));
    sseEvents.push(attachSseForwarderToQueue(name, push));
  }

  logger.info(
    { queues: ALL_QUEUE_NAMES, workers: workers.length },
    'job-infrastructure: started',
  );
  return { workers, trackerEvents, sseEvents };
}

export async function stopJobInfrastructure(infra: JobInfrastructure): Promise<void> {
  const closers: Promise<unknown>[] = [];
  for (const w of infra.workers) {
    closers.push(w.close().catch((err) => logger.error({ err }, 'job-infra: worker close failed')));
  }
  for (const e of infra.trackerEvents) {
    closers.push(e.close().catch((err) => logger.error({ err }, 'job-infra: tracker close failed')));
  }
  for (const e of infra.sseEvents) {
    closers.push(e.close().catch((err) => logger.error({ err }, 'job-infra: sse close failed')));
  }
  await Promise.all(closers);
}
