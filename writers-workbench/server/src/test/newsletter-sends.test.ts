import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

interface FakeSend {
  id: string;
  user_id: string;
  send_date: string;
  subject: string;
  preheader: string | null;
  html_body: string;
  markdown_body: string | null;
  scheduled_send_at: string | null;
  status: string;
  metadata: Record<string, unknown>;
}

interface FakeState {
  rows: FakeSend[];
  validUserIds: Set<string>;
  forceError?: string;
}

const state: FakeState = {
  rows: [],
  validUserIds: new Set(['+14105914612']),
};

function reset() {
  state.rows = [];
  state.validUserIds = new Set(['+14105914612']);
  delete state.forceError;
}

function buildChain(initialRows: () => FakeSend[], onResult: (rows: FakeSend[]) => { data: unknown; error: unknown }) {
  const filters: Record<string, unknown> = {};
  const notFilters: Record<string, unknown> = {};
  const lte: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters[col] = val; return builder; },
    neq(col: string, val: unknown) { notFilters[col] = val; return builder; },
    lte(col: string, val: unknown) { lte[col] = val; return builder; },
    order() { return builder; },
    select() { return builder; },
    maybeSingle() {
      const rows = initialRows().filter((r) => {
        for (const k of Object.keys(filters)) {
          if ((r as unknown as Record<string, unknown>)[k] !== filters[k]) return false;
        }
        for (const k of Object.keys(notFilters)) {
          if ((r as unknown as Record<string, unknown>)[k] === notFilters[k]) return false;
        }
        return true;
      });
      const result = onResult(rows);
      if (result.error) return Promise.resolve({ data: null, error: result.error });
      const arr = (result.data as FakeSend[] | null) ?? [];
      return Promise.resolve({ data: Array.isArray(arr) && arr.length ? arr[0] : null, error: null });
    },
    then(onFulfilled: (x: { data: unknown; error: unknown }) => unknown) {
      const rows = initialRows().filter((r) => {
        for (const k of Object.keys(filters)) {
          if ((r as unknown as Record<string, unknown>)[k] !== filters[k]) return false;
        }
        for (const k of Object.keys(notFilters)) {
          if ((r as unknown as Record<string, unknown>)[k] === notFilters[k]) return false;
        }
        for (const k of Object.keys(lte)) {
          if (String((r as unknown as Record<string, unknown>)[k]) > String(lte[k])) return false;
        }
        return true;
      });
      return Promise.resolve(onResult(rows)).then(onFulfilled);
    },
  };
  return builder;
}

const fakeSupabase = {
  from(table: string) {
    if (table !== 'newsletter_sends_v2') throw new Error(`Unexpected table: ${table}`);
    return {
      select(_cols: string) {
        return buildChain(
          () => state.rows,
          (rows) => state.forceError
            ? { data: null, error: { message: state.forceError, code: '99' } }
            : { data: rows, error: null },
        );
      },
      insert(row: Partial<FakeSend>) {
        return buildChain(
          () => {
            if (state.forceError) return [];
            if (row.user_id && !state.validUserIds.has(row.user_id)) return [];
            const next: FakeSend = {
              id: 'row-' + Math.random().toString(36).slice(2),
              user_id: row.user_id!,
              send_date: row.send_date!,
              subject: row.subject!,
              preheader: row.preheader ?? null,
              html_body: row.html_body!,
              markdown_body: row.markdown_body ?? null,
              scheduled_send_at: row.scheduled_send_at ?? null,
              status: (row.status as string) ?? 'scheduled',
              metadata: (row.metadata as Record<string, unknown>) ?? {},
            };
            state.rows.push(next);
            return [next];
          },
          (rows) => {
            if (state.forceError) return { data: null, error: { message: state.forceError, code: '99' } };
            if (row.user_id && !state.validUserIds.has(row.user_id)) {
              return { data: null, error: { message: 'FK violation', code: '23503' } };
            }
            return { data: rows, error: null };
          },
        );
      },
      update(updates: Partial<FakeSend>) {
        return buildChain(
          () => state.rows,
          (rows) => {
            if (state.forceError) return { data: null, error: { message: state.forceError, code: '99' } };
            for (const row of rows) {
              Object.assign(row, updates);
            }
            return { data: rows, error: null };
          },
        );
      },
    };
  },
};

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => fakeSupabase,
}));

const TEST_SECRET = 'test-ingestion-secret-abc';

beforeEach(() => {
  reset();
  process.env.INGESTION_SECRET = TEST_SECRET;
});

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/newsletter-sends.js');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/newsletter-sends', mod.newsletterSendsRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try { return await fn(`http://localhost:${port}/api/newsletter-sends`); }
  finally { server.close(); }
}

describe('Newsletter sends save (S11)', () => {
  it('rejects POST /save without X-Ingestion-Secret (401)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: '+14105914612', send_date: '2026-04-25',
          subject: 's', html_body: '<p>h</p>',
        }),
      });
      expect(r.status).toBe(401);
    });
  });

  it('saves with default scheduled_send_at ~24h in future', async () => {
    await withServer(async (base) => {
      const before = Date.now();
      const r = await fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+14105914612', send_date: '2026-04-25',
          subject: 'Daily AI', html_body: '<p>body</p>', markdown_body: '# Daily AI\nbody',
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { success: boolean; scheduled_send_at: string; status: string };
      expect(j.success).toBe(true);
      expect(j.status).toBe('scheduled');
      const scheduled = new Date(j.scheduled_send_at).getTime();
      expect(scheduled).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
      expect(scheduled).toBeLessThan(before + 25 * 60 * 60 * 1000);
    });
  });

  it('honors explicit scheduled_send_at', async () => {
    await withServer(async (base) => {
      const explicit = '2026-05-01T09:00:00+00:00';
      const r = await fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+14105914612', send_date: '2026-05-01',
          subject: 'Planned', html_body: '<p>body</p>', scheduled_send_at: explicit,
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { scheduled_send_at: string };
      expect(j.scheduled_send_at).toBe(explicit);
    });
  });

  it('upserts by (user_id, send_date) — re-save replaces', async () => {
    await withServer(async (base) => {
      const post = (subject: string) => fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+14105914612', send_date: '2026-04-25',
          subject, html_body: `<p>${subject}</p>`,
        }),
      });
      await post('first draft');
      await post('second draft');
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0].subject).toBe('second draft');
    });
  });

  it('FK violation on bad user_id surfaces as 400', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+19999999999', send_date: '2026-04-25',
          subject: 's', html_body: '<p>h</p>',
        }),
      });
      expect(r.status).toBe(400);
      const j = await r.json() as { error: { code: string } };
      expect(j.error.code).toBe('FK_VIOLATION');
    });
  });

  it('rejects bad send_date format (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify({
          user_id: '+14105914612', send_date: 'not-a-date',
          subject: 's', html_body: '<p>h</p>',
        }),
      });
      expect(r.status).toBe(400);
    });
  });
});
