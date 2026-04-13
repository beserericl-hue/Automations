/**
 * Sprint 6 QA Tests
 * Covers: S6-1 (admin routes), S6-7 (health check with Supabase check)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { healthRouter } from '../routes/health.js';
import { adminRouter } from '../routes/admin.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { Server } from 'http';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

describe('Sprint 6: Admin & Health', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createTestApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  describe('S6-7: Health check', () => {
    it('returns 200 with checks object', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string; service: string; checks: { supabase: string } };
      expect(json.status).toBe('ok');
      expect(json.service).toBe('writers-workbench');
      expect(json.checks).toBeDefined();
      expect(json.checks.supabase).toBe('skipped'); // No Supabase env in test
    });
  });

  describe('S6-1: Admin routes require auth', () => {
    it('GET /api/admin/users returns 401 without token', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users`);
      expect(res.status).toBe(401);
    });

    it('POST /api/admin/users returns 401 without token', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+14105551234', display_name: 'Test', email: 'test@test.com' }),
      });
      expect(res.status).toBe(401);
    });

    it('GET /api/admin/metrics returns 401 without token', async () => {
      const res = await fetch(`${baseUrl}/api/admin/metrics`);
      expect(res.status).toBe(401);
    });

    it('GET /api/admin/workflows returns 401 without token', async () => {
      const res = await fetch(`${baseUrl}/api/admin/workflows`);
      expect(res.status).toBe(401);
    });

    it('GET /api/admin/storage returns 401 without token', async () => {
      const res = await fetch(`${baseUrl}/api/admin/storage`);
      expect(res.status).toBe(401);
    });

    it('PUT /api/admin/users/:id returns 401 without token', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/%2B14105551234`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });
      expect(res.status).toBe(401);
    });

    it('DELETE /api/admin/users/:id returns 401 without token', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/%2B14105551234`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('S6-1: Admin validation schemas', () => {
    it('AdminUserSchema validates E.164 phone', async () => {
      const { AdminUserSchema } = await import('../schemas.js');
      const valid = AdminUserSchema.safeParse({
        phone: '+14105551234',
        display_name: 'Test User',
        email: 'test@example.com',
      });
      expect(valid.success).toBe(true);

      const invalid = AdminUserSchema.safeParse({
        phone: '4105551234', // missing +
        display_name: 'Test',
        email: 'test@example.com',
      });
      expect(invalid.success).toBe(false);
    });

    it('AdminUserUpdateSchema accepts partial fields', async () => {
      const { AdminUserUpdateSchema } = await import('../schemas.js');
      const valid = AdminUserUpdateSchema.safeParse({ role: 'editor' });
      expect(valid.success).toBe(true);

      const invalidRole = AdminUserUpdateSchema.safeParse({ role: 'superadmin' });
      expect(invalidRole.success).toBe(false);
    });
  });
});
