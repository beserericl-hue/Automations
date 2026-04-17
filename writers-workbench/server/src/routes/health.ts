import { Router } from 'express';

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

  const hasErrors = Object.values(checks).some((v) => v === 'error');

  res.status(hasErrors ? 503 : 200).json({
    status: hasErrors ? 'degraded' : 'ok',
    service: 'writers-workbench',
    timestamp: new Date().toISOString(),
    checks,
  });
});
