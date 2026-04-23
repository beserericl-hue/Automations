import { Router } from 'express';

const nonEmpty = (v: string | undefined) =>
  v && v !== 'unknown' ? v : undefined;

const BUILD_SHA =
  nonEmpty(process.env.BUILD_SHA) ||
  nonEmpty(process.env.RAILWAY_GIT_COMMIT_SHA) ||
  'unknown';
const DEPLOYED_AT =
  nonEmpty(process.env.BUILD_TIME) || new Date().toISOString();

export const healthRouter = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Service health check
 *     description: Returns service status and component health checks (Supabase connectivity).
 *     responses:
 *       200:
 *         description: All systems healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *       503:
 *         description: One or more components degraded
 */
healthRouter.get('/', async (_req, res) => {
  const checks: Record<string, 'ok' | 'error' | 'skipped'> = {};

  // Supabase connectivity
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { getSupabaseAdmin } = await import('../services/supabase-admin.js');
      const supabase = getSupabaseAdmin();
      const { error } = await supabase.from('users_v2').select('id', { count: 'exact', head: true });
      checks.supabase = error ? 'error' : 'ok';
    } catch {
      checks.supabase = 'error';
    }
  } else {
    checks.supabase = 'skipped';
  }

  // Redis connectivity
  if (process.env.REDIS_URL) {
    try {
      const { redisHealthy } = await import('../lib/redis.js');
      checks.redis = (await redisHealthy()) ? 'ok' : 'error';
    } catch {
      checks.redis = 'error';
    }
  } else {
    checks.redis = 'skipped';
  }

  // Postal reachability (only when DRY_RUN_EMAIL is not set)
  if (process.env.POSTAL_API_URL && process.env.DRY_RUN_EMAIL !== 'true') {
    try {
      const { postalReachable } = await import('../lib/email.js');
      checks.postal = (await postalReachable()) ? 'ok' : 'error';
    } catch {
      checks.postal = 'error';
    }
  } else {
    checks.postal = 'skipped';
  }

  const hasErrors = Object.values(checks).some((v) => v === 'error');

  res.status(hasErrors ? 503 : 200).json({
    status: hasErrors ? 'degraded' : 'ok',
    service: 'writers-workbench',
    environment: process.env.NODE_ENV || 'development',
    version: BUILD_SHA,
    deployed_at: DEPLOYED_AT,
    timestamp: new Date().toISOString(),
    checks,
  });
});
