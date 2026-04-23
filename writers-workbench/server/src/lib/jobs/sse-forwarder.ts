/**
 * SSE forwarder: turns BullMQ queue-event transitions (active / completed /
 * failed) into push notifications on the user's SSE channel.
 *
 * This runs alongside the job-tracker — the tracker persists lifecycle to
 * job_queue_v2 for audit; the forwarder emits a live event so the chat
 * drawer can flip its "Queued" badge to "Processing" / "Complete" without
 * polling.
 *
 * Implementation: listens to QueueEvents for the queue, then looks up the
 * job's user_id in job_queue_v2 so the SSE push is scoped correctly.
 * (QueueEvents payloads don't include the job data, so we need the lookup.)
 */

import { QueueEvents } from 'bullmq';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';
import { getSupabaseAdmin } from '../../services/supabase-admin.js';

export type SsePushFn = (userId: string, event: Record<string, unknown>) => number;

interface TrackerMeta {
  user_id: string;
  job_type: string;
  queue_name: string;
}

async function lookupJob(bullJobId: string): Promise<TrackerMeta | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('job_queue_v2')
      .select('user_id, job_type, queue_name')
      .eq('job_id', bullJobId)
      .maybeSingle();
    if (error) {
      logger.error({ err: error, bullJobId }, 'sse-forwarder: lookup failed');
      return null;
    }
    return (data as TrackerMeta | null) ?? null;
  } catch (err) {
    logger.error({ err, bullJobId }, 'sse-forwarder: lookup threw');
    return null;
  }
}

export function attachSseForwarderToQueue(
  queueName: string,
  push: SsePushFn,
): QueueEvents {
  const events = new QueueEvents(queueName, { connection: getRedis() });

  const emit = async (bullJobId: string, status: string, extra: Record<string, unknown> = {}) => {
    const meta = await lookupJob(bullJobId);
    if (!meta) return;
    push(meta.user_id, {
      type: 'job-status',
      jobId: bullJobId,
      status,
      job_type: meta.job_type,
      queue: meta.queue_name,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  };

  events.on('active', ({ jobId }) => {
    void emit(jobId, 'active');
  });

  events.on('completed', ({ jobId, returnvalue }) => {
    void emit(jobId, 'completed', { result: safeParse(returnvalue) });
  });

  events.on('failed', ({ jobId, failedReason }) => {
    void emit(jobId, 'failed', { error: failedReason?.slice(0, 500) ?? null });
  });

  return events;
}

function safeParse(ret: unknown): unknown {
  if (typeof ret !== 'string') return ret;
  try {
    return JSON.parse(ret);
  } catch {
    return ret;
  }
}
