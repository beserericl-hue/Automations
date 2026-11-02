/**
 * Cost breakdowns from token_usage_v2, aggregated in Postgres (token_usage_breakdown, migration 043).
 *
 *   GET /api/costs/breakdown        — the caller's own costs (the impersonated user's when a
 *                                     superuser is impersonating: req.userId is the effective user)
 *   GET /api/admin/costs/breakdown  — every user's costs; admin/superuser only; may group by user
 *
 * Aggregating server-side is the point: PostgREST caps a select at 1000 rows, and summing a capped
 * select is how the old dashboard's totals silently stopped growing.
 */
import { Router, type Request, type Response } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

export const USER_GROUPS = ['operation', 'provider', 'model', 'project', 'day', 'operation_model', 'total'] as const;
export const ADMIN_GROUPS = [...USER_GROUPS, 'user'] as const;

const DAY_MS = 24 * 3600 * 1000;
const MAX_RANGE_MS = 10 * 366 * DAY_MS;

export interface BreakdownParams {
  p_from: string;
  p_to: string;
  p_group: string;
  p_user_id: string | null;
  p_project_id: string | null;
  p_operation: string | null;
  p_provider: string | null;
  p_model: string | null;
}

function str(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

/** Parse + validate the query string. Returns an error message instead of params when invalid. */
export function parseBreakdownQuery(
  q: Record<string, unknown>,
  allowed: readonly string[],
  now = new Date(),
): { params: Omit<BreakdownParams, 'p_user_id'> } | { error: string } {
  const group = str(q.group, 40) ?? 'operation';
  if (!allowed.includes(group)) return { error: `group must be one of: ${allowed.join(', ')}` };
  const to = q.to !== undefined ? new Date(String(q.to)) : now;
  const from = q.from !== undefined ? new Date(String(q.from)) : new Date(to.getTime() - 30 * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: 'from/to must be ISO dates' };
  if (from >= to) return { error: 'from must be before to' };
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) return { error: 'date range is limited to 10 years' };
  return {
    params: {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_group: group,
      p_project_id: str(q.project_id),
      p_operation: str(q.operation),
      p_provider: str(q.provider, 40),
      p_model: str(q.model),
    },
  };
}

async function breakdown(res: Response, params: BreakdownParams): Promise<void> {
  const supabase = getSupabaseAdmin();
  const [rowsRes, totalRes] = await Promise.all([
    supabase.rpc('token_usage_breakdown', params),
    supabase.rpc('token_usage_breakdown', { ...params, p_group: 'total' }),
  ]);
  const err = rowsRes.error ?? totalRes.error;
  if (err) {
    logger.error({ error: err.message }, 'costs: breakdown failed');
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: err.message } });
    return;
  }
  const totalRows = (totalRes.data ?? []) as Record<string, unknown>[];
  const rows = (rowsRes.data ?? []) as unknown[];
  res.json({
    success: true,
    data: {
      group: params.p_group,
      from: params.p_from,
      to: params.p_to,
      rows,
      totals: totalRows[0] ?? null,
      // PostgREST caps an RPC result at 1000 rows too. Totals come from their own one-row call, so
      // they stay exact; this only says the per-group list was cut (e.g. "day" over several years).
      truncated: rows.length >= 1000,
    },
  });
}

export const costsRouter = Router();
costsRouter.use(requireAuth);

/**
 * @openapi
 * /costs/breakdown:
 *   get:
 *     tags: [Costs]
 *     summary: The caller's provider costs, aggregated by operation, provider, model, project or day
 *     description: >
 *       Sums token_usage_v2 in the database (never a capped select). Each row carries calls, distinct
 *       runs, token and unit counts, cost, average cost per call and per run, and how many of its calls
 *       were provider-reported, estimated or unpriced.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *       - in: query
 *         name: group
 *         schema: { type: string, enum: [operation, provider, model, project, day, operation_model, total] }
 *       - { in: query, name: project_id, schema: { type: string } }
 *       - { in: query, name: operation, schema: { type: string } }
 *       - { in: query, name: provider, schema: { type: string } }
 *       - { in: query, name: model, schema: { type: string } }
 *     responses:
 *       200: { description: "{ rows, totals }" }
 *       400: { description: Invalid parameters }
 */
costsRouter.get('/breakdown', async (req: Request, res: Response) => {
  const parsed = parseBreakdownQuery(req.query as Record<string, unknown>, USER_GROUPS);
  if ('error' in parsed) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: parsed.error } });
    return;
  }
  await breakdown(res, { ...parsed.params, p_user_id: req.userId! });
});

export const adminCostsRouter = Router();
adminCostsRouter.use(requireAuth, requireAdmin);

/**
 * @openapi
 * /admin/costs/breakdown:
 *   get:
 *     tags: [Admin]
 *     summary: Provider costs across every user (admin)
 *     description: Same as /costs/breakdown, across all users; optional user_id filter; group may also be "user".
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *       - in: query
 *         name: group
 *         schema: { type: string, enum: [operation, provider, model, project, day, operation_model, user, total] }
 *       - { in: query, name: user_id, schema: { type: string } }
 *       - { in: query, name: project_id, schema: { type: string } }
 *       - { in: query, name: operation, schema: { type: string } }
 *       - { in: query, name: provider, schema: { type: string } }
 *       - { in: query, name: model, schema: { type: string } }
 *     responses:
 *       200: { description: "{ rows, totals }" }
 *       400: { description: Invalid parameters }
 *       403: { description: Not an admin }
 */
adminCostsRouter.get('/breakdown', async (req: Request, res: Response) => {
  const parsed = parseBreakdownQuery(req.query as Record<string, unknown>, ADMIN_GROUPS);
  if ('error' in parsed) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: parsed.error } });
    return;
  }
  await breakdown(res, { ...parsed.params, p_user_id: str(req.query.user_id) });
});
