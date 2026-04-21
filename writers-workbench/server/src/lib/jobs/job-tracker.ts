/**
 * Job tracker: listens to BullMQ queue events and mirrors the job
 * lifecycle into public.job_queue_v2 (migration 008).
 *
 * BullMQ is the source of truth for live job state; this table is the
 * durable audit trail and feeds the admin queue dashboard (S10b-4).
 * The tracker is side-effect-only — workers don't depend on it to run.
 */

import { QueueEvents, type Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';
import { getSupabaseAdmin } from '../../services/supabase-admin.js';
import type { AnyJob } from './types.js';

interface AddJobInput<T extends AnyJob> {
  queue: Queue<T>;
  jobName: string;
  data: T;
  priority: number;
  /** job_queue_v2.job_type — short tag for audit. */
  jobTypeTag: string;
}

/**
 * Enqueue a BullMQ job AND insert the matching row into job_queue_v2 in
 * one call. Use this everywhere jobs are created so the audit table
 * never gets out of sync with BullMQ.
 */
export async function addTrackedJob<T extends AnyJob>(
  input: AddJobInput<T>,
): Promise<{ bullJobId: string; trackerRowId: string | null }> {
  const { queue, jobName, data, priority, jobTypeTag } = input;

  // BullMQ's Queue<T, R, N> generics constrain add(name) to N; we
  // intentionally keep N loose so callers can pass any string.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job = await (queue as any).add(jobName, data, { priority });
  if (!job.id) {
    // Should be unreachable per BullMQ semantics, but guard so TS narrows.
    throw new Error('BullMQ returned a job without an id');
  }

  const trackerRowId = await recordJobCreated({
    bullJobId: job.id,
    queueName: queue.name,
    userId: data.userId,
    jobType: jobTypeTag,
    priority,
    payload: data as unknown as Record<string, unknown>,
  });

  return { bullJobId: job.id, trackerRowId };
}

async function recordJobCreated(input: {
  bullJobId: string;
  queueName: string;
  userId: string;
  jobType: string;
  priority: number;
  payload: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('job_queue_v2')
      .insert({
        user_id: input.userId,
        job_id: input.bullJobId,
        queue_name: input.queueName,
        job_type: input.jobType,
        status: 'waiting',
        priority: input.priority,
        payload: input.payload,
      })
      .select('id')
      .single();
    if (error) {
      logger.error({ err: error, jobId: input.bullJobId }, 'job-tracker: insert failed');
      return null;
    }
    return (data as { id: string }).id;
  } catch (err) {
    logger.error({ err, jobId: input.bullJobId }, 'job-tracker: insert threw');
    return null;
  }
}

/**
 * Attach QueueEvents listeners that keep job_queue_v2 in sync with
 * BullMQ transitions. One QueueEvents instance per queue name.
 */
export function attachTrackerToQueue(queueName: string): QueueEvents {
  const events = new QueueEvents(queueName, { connection: getRedis() });

  events.on('active', ({ jobId }) => {
    void updateJobStatus(jobId, { status: 'active', started_at: new Date().toISOString() });
  });

  events.on('completed', ({ jobId, returnvalue }) => {
    void updateJobStatus(jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result: safeParseReturn(returnvalue),
    });
  });

  events.on('failed', ({ jobId, failedReason }) => {
    void updateJobStatus(jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: failedReason?.slice(0, 2_000) ?? null,
    });
  });

  events.on('stalled', ({ jobId }) => {
    void updateJobStatus(jobId, { status: 'stalled' });
  });

  events.on('progress', () => {
    // no-op for now; progress events don't update the audit table
  });

  return events;
}

function safeParseReturn(ret: unknown): unknown {
  if (typeof ret !== 'string') return ret;
  try {
    return JSON.parse(ret);
  } catch {
    return ret;
  }
}

/**
 * Update a tracker row keyed by BullMQ job_id. Also bumps attempts +
 * duration_ms when we transition to a terminal state.
 */
export async function updateJobStatus(
  bullJobId: string,
  patch: Partial<{
    status: string;
    started_at: string;
    completed_at: string;
    result: unknown;
    error_message: string | null;
    attempts: number;
  }>,
): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();

    // When transitioning to a terminal state, also compute duration_ms.
    let withDuration: Record<string, unknown> = { ...patch };
    if ('completed_at' in patch && patch.completed_at) {
      const { data: row } = await supabase
        .from('job_queue_v2')
        .select('started_at')
        .eq('job_id', bullJobId)
        .single();
      const startedAt = (row as { started_at: string | null } | null)?.started_at;
      if (startedAt) {
        const durationMs =
          new Date(patch.completed_at).getTime() - new Date(startedAt).getTime();
        withDuration.duration_ms = durationMs;
      }
    }

    const { error } = await supabase
      .from('job_queue_v2')
      .update(withDuration)
      .eq('job_id', bullJobId);

    if (error) {
      logger.error({ err: error, bullJobId }, 'job-tracker: update failed');
    }
  } catch (err) {
    logger.error({ err, bullJobId }, 'job-tracker: update threw');
  }
}
