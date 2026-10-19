import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

/**
 * `GET /api/impersonate/data/research` accepted `project_id` and then ignored it.
 *
 * ProjectDetail.tsx has been sending that parameter all along (it is the impersonation branch of the
 * research tab), so a superuser opening one project's Research tab saw the user's ENTIRE research
 * library — on the live account that is 193 reports where the project has 23. Exactly the bug the
 * research_report_projects_v2 link table was introduced to fix, still live on this path while the
 * non-impersonated path was correct.
 */

interface Report { id: string; user_id: string; topic: string; deleted_at: string | null }
interface Link { report_id: string; project_id: string }

const OSSUARY = 'a1bfb2cf-2949-4d29-80d2-e8b785c6bdae';
const OTHER = 'bbbbbbbb-2949-4d29-80d2-e8b785c6bdae';
const USER = '+14105914612';

const state = {
  reports: [] as Report[],
  links: [] as Link[],
  linkError: null as string | null,
};

function reset() {
  state.reports = [
    { id: 'r1', user_id: USER, topic: 'Stratum III — Diaspora', deleted_at: null },
    { id: 'r2', user_id: USER, topic: 'Stratum IV — The crisis of the 1670s', deleted_at: null },
    { id: 'r3', user_id: USER, topic: 'A different project entirely', deleted_at: null },
    { id: 'r4', user_id: USER, topic: 'Deleted Ossuary report', deleted_at: '2026-10-01T00:00:00Z' },
    { id: 'r5', user_id: '+17063338699', topic: "Another user's report", deleted_at: null },
  ];
  state.links = [
    { report_id: 'r1', project_id: OSSUARY },
    { report_id: 'r2', project_id: OSSUARY },
    { report_id: 'r4', project_id: OSSUARY },
    { report_id: 'r3', project_id: OTHER },
    // r5 belongs to another user but is (wrongly) linked to this project: the route must still
    // scope by user, so a link row cannot leak another account's report.
    { report_id: 'r5', project_id: OSSUARY },
  ];
  state.linkError = null;
}

function builder(table: string) {
  const eqs: Record<string, unknown> = {};
  let inIds: string[] | null = null;
  let nullCol: string | null = null;

  const b: Record<string, unknown> = {
    select() { return b; },
    eq(col: string, val: unknown) { eqs[col] = val; return b; },
    in(_col: string, vals: string[]) { inIds = vals; return b; },
    is(col: string, val: unknown) { if (val === null) nullCol = col; return b; },
    order() { return b; },
    limit() {
      if (table === 'research_report_projects_v2') {
        if (state.linkError) return Promise.resolve({ data: null, error: { message: state.linkError } });
        return Promise.resolve({
          data: state.links.filter((l) => l.project_id === eqs.project_id),
          error: null,
        });
      }
      const rows = state.reports.filter((r) => {
        if (eqs.user_id && r.user_id !== eqs.user_id) return false;
        if (inIds && !inIds.includes(r.id)) return false;
        if (nullCol === 'deleted_at' && r.deleted_at !== null) return false;
        return true;
      });
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return b;
}

vi.mock('../services/supabase-admin.js', () => ({ getSupabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  // The router applies requireAuth + requireSuperuser itself. These tests are about the query
  // scoping, so the gate is replaced with one that supplies the same identity the real middleware
  // would after honouring X-Impersonate-User.
  vi.doMock('../middleware/auth.js', () => ({
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as express.Request & { userId: string }).userId = USER;
      (req as express.Request & { realUserId: string }).realUserId = USER;
      (req as express.Request & { effectiveRole: string }).effectiveRole = 'superuser';
      next();
    },
    requireSuperuser: (_q: unknown, _r: unknown, n: express.NextFunction) => n(),
    requireAdmin: (_q: unknown, _r: unknown, n: express.NextFunction) => n(),
    requireTierFeature: () => (_q: unknown, _r: unknown, n: express.NextFunction) => n(),
    requireCredits: () => (_q: unknown, _r: unknown, n: express.NextFunction) => n(),
  }));
  vi.resetModules();
  const { impersonateDataRouter } = await import('../routes/impersonate-data.js');
  const app = express();
  app.use(express.json());
  app.use('/api/impersonate/data', impersonateDataRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://localhost:${port}/api/impersonate/data`);
  } finally {
    server.close();
    vi.doUnmock('../middleware/auth.js');
  }
}

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as { data?: Report[]; error?: unknown } };
}

beforeEach(reset);

describe('GET /impersonate/data/research', () => {
  it('returns only the given project reports when project_id is supplied', async () => {
    await withServer(async (base) => {
      const { status, body } = await get(base, `/research?project_id=${OSSUARY}&limit=50`);
      expect(status).toBe(200);
      const ids = (body.data ?? []).map((r) => r.id).sort();
      // r1 + r2 only: r3 is another project, r4 is deleted, r5 is another user.
      expect(ids).toEqual(['r1', 'r2']);
    });
  });

  it('does not leak another user report that is linked to the project', async () => {
    await withServer(async (base) => {
      const { body } = await get(base, `/research?project_id=${OSSUARY}&limit=50`);
      expect((body.data ?? []).some((r) => r.user_id !== USER)).toBe(false);
    });
  });

  it('returns an empty list rather than everything when a project has no research', async () => {
    await withServer(async (base) => {
      const { body } = await get(base, `/research?project_id=cccccccc-0000-0000-0000-000000000000`);
      expect(body.data).toEqual([]);
    });
  });

  it('still returns the whole library when no project_id is given', async () => {
    await withServer(async (base) => {
      const { body } = await get(base, '/research?limit=50');
      const ids = (body.data ?? []).map((r) => r.id).sort();
      expect(ids).toEqual(['r1', 'r2', 'r3']); // the user's, minus the deleted one
    });
  });

  it('surfaces a link-table failure instead of silently widening the scope', async () => {
    await withServer(async (base) => {
      state.linkError = 'relation does not exist';
      const { status } = await get(base, `/research?project_id=${OSSUARY}`);
      expect(status).toBe(500);
    });
  });
});
