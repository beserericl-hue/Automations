import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { getNamedQueue } from '../lib/queue.js';
import { ALL_QUEUE_NAMES, type QueueName } from '../lib/jobs/types.js';
import { getEngineJob, abortEngineJob } from '../lib/engine-hub.js';

export const jobsRouter = Router();

/**
 * CR-008 C: poll an ENGINE arq job (Path B). When HUB_BACKEND=engine, chat returns
 * `{ engineJob: true, jobId }`; the client polls here, which proxies the engine gateway's
 * /internal/write/jobs/{id}. Status ∈ queued | in_progress | complete | error | not_found.
 */
jobsRouter.get('/engine/:id/status', requireAuth, async (req: Request, res: Response) => {
  const jobId = String(req.params.id);
  try {
    const job = await getEngineJob(jobId);
    res.json({ jobId, engineJob: true, status: job.status, result: job.result, error: job.error });
  } catch (err) {
    logger.error({ err, jobId }, 'jobs: engine poll failed');
    res.status(502).json({ error: 'Failed to reach engine job' });
  }
});

/**
 * Cancel an ENGINE arq job (Path B) — the Fix Drift "Cancel" button. Proxies the engine gateway's
 * POST /internal/write/jobs/{id}/abort. Idempotent: a job that already finished returns aborted:false.
 */
jobsRouter.post('/engine/:id/abort', requireAuth, async (req: Request, res: Response) => {
  const jobId = String(req.params.id);
  try {
    const { aborted, error } = await abortEngineJob(jobId);
    if (error) {
      res.status(502).json({ error });
      return;
    }
    res.json({ jobId, engineJob: true, aborted });
  } catch (err) {
    logger.error({ err, jobId }, 'jobs: engine abort failed');
    res.status(502).json({ error: 'Failed to reach engine job' });
  }
});

const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const CANCELLABLE_STATUSES = new Set(['waiting', 'delayed']);

interface JobRow {
  id: string;
  user_id: string;
  job_id: string;
  queue_name: string;
  job_type: string;
  status: string;
  priority: number;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
}

/**
 * @openapi
 * /jobs/stats:
 *   get:
 *     tags: [Jobs]
 *     summary: Summary counts of the authenticated user's jobs
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Counts grouped by status.
 */
jobsRouter.get('/stats', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('job_queue_v2')
      .select('status')
      .eq('user_id', userId);

    if (error) {
      logger.error({ err: error, userId }, 'jobs/stats: query failed');
      res.status(500).json({ success: false, error: { code: 'QUERY_FAILED', message: error.message } });
      return;
    }

    const counts: Record<string, number> = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      stalled: 0,
      delayed: 0,
    };
    for (const row of (data ?? []) as { status: string }[]) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }

    res.json({ success: true, counts, total: (data ?? []).length });
  } catch (err) {
    logger.error({ err, userId }, 'jobs/stats: threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Failed to load stats' } });
  }
});

/**
 * @openapi
 * /jobs:
 *   get:
 *     tags: [Jobs]
 *     summary: List the authenticated user's recent jobs
 *     description: Returns up to 100 of the user's jobs, most recent first. Supports optional status filter.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Optional status filter (waiting|active|completed|failed|stalled|delayed)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Max rows to return (1-100; default 50).
 *     responses:
 *       200:
 *         description: Job rows
 */
jobsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;

  try {
    const supabase = getSupabaseAdmin();
    let q = supabase
      .from('job_queue_v2')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) {
      logger.error({ err: error, userId }, 'jobs: list failed');
      res.status(500).json({ success: false, error: { code: 'QUERY_FAILED', message: error.message } });
      return;
    }
    res.json({ success: true, jobs: data ?? [] });
  } catch (err) {
    logger.error({ err, userId }, 'jobs: list threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Failed to list jobs' } });
  }
});

/**
 * Find a tracker row by either the tracker UUID (`id`) or the BullMQ
 * `job_id`, scoped to the authenticated user. Returns null if not found
 * (or if it belongs to another user — the user can't distinguish).
 */
async function findUserJob(userId: string, idOrJobId: string): Promise<JobRow | null> {
  const supabase = getSupabaseAdmin();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrJobId);

  const { data, error } = await supabase
    .from('job_queue_v2')
    .select('*')
    .eq(isUuid ? 'id' : 'job_id', idOrJobId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    logger.error({ err: error, userId, idOrJobId }, 'jobs: findUserJob failed');
    return null;
  }
  return (data as JobRow | null) ?? null;
}

/**
 * @openapi
 * /jobs/{id}/status:
 *   get:
 *     tags: [Jobs]
 *     summary: Lightweight status poll for a single job
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Tracker UUID or BullMQ job_id.
 *     responses:
 *       200:
 *         description: Status fields only (status, attempts, duration_ms, completed_at).
 *       404:
 *         description: Job not found for user
 */
jobsRouter.get('/:id/status', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const idParam = String(req.params.id);
  const row = await findUserJob(userId, idParam);
  if (!row) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
    return;
  }
  res.json({
    success: true,
    id: row.id,
    jobId: row.job_id,
    status: row.status,
    attempts: row.attempts,
    duration_ms: row.duration_ms,
    completed_at: row.completed_at,
    error_message: row.error_message,
  });
});

/**
 * @openapi
 * /jobs/{id}:
 *   get:
 *     tags: [Jobs]
 *     summary: Full detail for a single job
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Tracker UUID or BullMQ job_id.
 *     responses:
 *       200:
 *         description: Full job row.
 *       404:
 *         description: Job not found for user
 */
jobsRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const idParam = String(req.params.id);
  const row = await findUserJob(userId, idParam);
  if (!row) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
    return;
  }
  res.json({ success: true, job: row });
});

/**
 * @openapi
 * /jobs/{id}:
 *   delete:
 *     tags: [Jobs]
 *     summary: Cancel a waiting job
 *     description: Only jobs in waiting or delayed state can be cancelled. Active and terminal jobs return 409.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job cancelled
 *       404:
 *         description: Job not found for user
 *       409:
 *         description: Job cannot be cancelled in current state
 */
jobsRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const idParam = String(req.params.id);
  const row = await findUserJob(userId, idParam);
  if (!row) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
    return;
  }

  if (TERMINAL_STATUSES.has(row.status)) {
    res.status(409).json({
      success: false,
      error: { code: 'ALREADY_TERMINAL', message: `Job already ${row.status}` },
    });
    return;
  }
  if (!CANCELLABLE_STATUSES.has(row.status)) {
    res.status(409).json({
      success: false,
      error: { code: 'NOT_CANCELLABLE', message: `Cannot cancel job in ${row.status} state` },
    });
    return;
  }

  if (!ALL_QUEUE_NAMES.includes(row.queue_name as QueueName)) {
    res.status(500).json({
      success: false,
      error: { code: 'UNKNOWN_QUEUE', message: `Unknown queue: ${row.queue_name}` },
    });
    return;
  }

  try {
    const queue = getNamedQueue(row.queue_name as QueueName);
    const bullJob = await queue.getJob(row.job_id);
    if (bullJob) {
      await bullJob.remove();
    }

    const supabase = getSupabaseAdmin();
    const { error: updateError } = await supabase
      .from('job_queue_v2')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: 'Cancelled by user',
      })
      .eq('id', row.id);
    if (updateError) {
      logger.error({ err: updateError, jobId: row.job_id }, 'jobs: cancel update failed');
    }

    res.json({ success: true, id: row.id, jobId: row.job_id, status: 'cancelled' });
  } catch (err) {
    logger.error({ err, jobId: row.job_id, userId }, 'jobs: cancel threw');
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Failed to cancel job' } });
  }
});
