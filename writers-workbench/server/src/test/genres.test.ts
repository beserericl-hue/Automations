/**
 * Migration 013 — server route tests.
 *
 * Covers the per-genre user-ingestion-URL endpoints and the admin/ingestion
 * cross-user view added on top of Sprint 8's RBAC. The migration's RLS is
 * smoke-tested live against DEV Supabase before this lands; these tests
 * exercise the route logic — schema validation, role-gated insert paths,
 * 404/403/409 surfaces, query filters.
 *
 * Auth is stubbed: requireAuth sets req.userId and req.effectiveRole; tests
 * flip the role via a setter so admin / superuser / user can be exercised
 * in the same suite.
 *
 * Supabase admin client is replaced with an in-memory fake that records
 * .from(table)... chains so we can assert filtering + ordering without a
 * real database connection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const TEST_USER_OWNER = '+14105914612';   // test admin/owner
const TEST_USER_OTHER = '+17063338699';   // regular user
let TEST_USER_ID = TEST_USER_OWNER;
let TEST_EFFECTIVE_ROLE: 'user' | 'admin' | 'superuser' = 'superuser';

interface FakeUrlRow {
  id: string;
  genre_slug: string;
  url: string;
  url_type: string;
  visibility: string;
  created_by_user_id: string;
  label: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface FakeIngestionRow {
  id: string;
  key: string;
  user_id: string;
  type: string;
  title: string | null;
  source_name: string;
  source_url: string | null;
  created_at: string;
  deleted_at: string | null;
}

interface State {
  urls: FakeUrlRow[];
  ingestion: FakeIngestionRow[];
  forceInsertError?: { code?: string; message: string };
  forceQueryError?: string;
}
const state: State = { urls: [], ingestion: [] };

function reset() {
  state.urls = [];
  state.ingestion = [];
  delete state.forceInsertError;
  delete state.forceQueryError;
  TEST_USER_ID = TEST_USER_OWNER;
  TEST_EFFECTIVE_ROLE = 'superuser';
}

function uuid(): string {
  return 'aaaaaaaa-aaaa-aaaa-aaaa-' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');
}

// ---------------------------------------------------------------------------
// In-memory Supabase fake — enough for what genres.ts + admin.ts/ingestion need.
// ---------------------------------------------------------------------------

function buildSelectBuilder<T extends { id: string }>(getRows: () => T[], tableName: string) {
  const filters: Array<{ kind: 'eq' | 'is' | 'like'; col: string; val: unknown }> = [];
  const orFilters: string[] = [];
  let limitN: number | undefined;
  // Bookkeeping for .order() so the test can rely on insertion order — we
  // don't actually need to sort because tests assert on row contents, not
  // ordering, but the chain must accept it.
  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters.push({ kind: 'eq', col, val }); return builder; },
    is(col: string, val: unknown) { filters.push({ kind: 'is', col, val }); return builder; },
    like(col: string, val: unknown) { filters.push({ kind: 'like', col, val: String(val) }); return builder; },
    or(expr: string) { orFilters.push(expr); return builder; },
    order() { return builder; },
    limit(n: number) { limitN = n; return builder; },
    maybeSingle() {
      const filtered = applyFilters();
      const err = state.forceQueryError;
      if (err) return Promise.resolve({ data: null, error: { message: err, code: '99' } });
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
    },
    single() {
      const filtered = applyFilters();
      if (filtered.length === 0) return Promise.resolve({ data: null, error: { message: 'No rows', code: 'PGRST116' } });
      return Promise.resolve({ data: filtered[0], error: null });
    },
    then(onFulfilled: (x: { data: T[] | null; error: unknown }) => unknown) {
      const err = state.forceQueryError;
      if (err) return Promise.resolve({ data: null, error: { message: err } }).then(onFulfilled);
      const filtered = applyFilters();
      const result = limitN ? filtered.slice(0, limitN) : filtered;
      return Promise.resolve({ data: result, error: null }).then(onFulfilled);
    },
  };
  function applyFilters(): T[] {
    let rows = getRows();
    for (const f of filters) {
      if (f.kind === 'eq') rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[f.col] === f.val);
      if (f.kind === 'is' && f.val === null) rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[f.col] == null);
      if (f.kind === 'like') {
        const pattern = String(f.val);
        // PostgREST .like() uses % as wildcard; we only need prefix matches in the tests.
        const prefix = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern;
        rows = rows.filter((r) => String((r as unknown as Record<string, unknown>)[f.col] ?? '').startsWith(prefix));
      }
    }
    if (orFilters.length > 0) {
      // Single supported pattern: "visibility.eq.public,created_by_user_id.eq.<id>"
      // Used by GET /api/genres/:slug/urls for non-admins.
      rows = rows.filter((r) => {
        for (const expr of orFilters) {
          const branches = expr.split(',');
          for (const branch of branches) {
            const m = branch.match(/^([a-z_]+)\.eq\.(.+)$/);
            if (!m) continue;
            const [, col, valEnc] = m;
            const val = decodeURIComponent(valEnc);
            if ((r as unknown as Record<string, unknown>)[col] === val) return true;
          }
        }
        return false;
      });
    }
    void tableName; // silence unused warning when testing without strict mode
    return rows;
  }
  return builder;
}

const fakeSupabase = {
  from(table: string) {
    if (table === 'genre_ingestion_urls_v2') {
      return {
        select: () => buildSelectBuilder<FakeUrlRow>(() => state.urls, table),
        insert: (row: Partial<FakeUrlRow>) => {
          if (state.forceInsertError) {
            const err = state.forceInsertError;
            return {
              select: () => ({ single: () => Promise.resolve({ data: null, error: err }) }),
            };
          }
          // Enforce the same UNIQUE constraint the migration carries:
          // (genre_slug, url_type, lower(url), visibility, created_by_user_id)
          const dup = state.urls.find(
            (r) =>
              r.genre_slug === row.genre_slug &&
              r.url_type === row.url_type &&
              r.url?.toLowerCase() === (row.url ?? '').toLowerCase() &&
              r.visibility === row.visibility &&
              r.created_by_user_id === row.created_by_user_id,
          );
          if (dup) {
            return {
              select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } }) }),
            };
          }
          const newRow: FakeUrlRow = {
            id: uuid(),
            genre_slug: row.genre_slug!,
            url: row.url!,
            url_type: row.url_type!,
            visibility: row.visibility ?? 'private',
            created_by_user_id: row.created_by_user_id!,
            label: row.label ?? null,
            active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          state.urls.push(newRow);
          return {
            select: () => ({ single: () => Promise.resolve({ data: newRow, error: null }) }),
          };
        },
        delete: () => {
          let toDeleteIds: string[] = [];
          const builder: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              if (col === 'id') toDeleteIds = state.urls.filter((r) => r.id === val).map((r) => r.id);
              return builder;
            },
            then(onFulfilled: (x: { data: null; error: null }) => unknown) {
              state.urls = state.urls.filter((r) => !toDeleteIds.includes(r.id));
              return Promise.resolve({ data: null, error: null }).then(onFulfilled);
            },
          };
          return builder;
        },
      };
    }
    if (table === 'content_ingestion_v2') {
      return { select: () => buildSelectBuilder<FakeIngestionRow>(() => state.ingestion, table) };
    }
    throw new Error('unexpected table: ' + table);
  },
};

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => fakeSupabase,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string; effectiveRole?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER_ID;
    req.effectiveRole = TEST_EFFECTIVE_ROLE;
    next();
  },
  requireAdmin: (req: { effectiveRole?: string }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (req.effectiveRole !== 'admin' && req.effectiveRole !== 'superuser') {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } });
      return;
    }
    next();
  },
}));

beforeEach(() => {
  reset();
});

async function withGenresServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/genres.js');
  const app = express();
  app.use(express.json());
  app.use('/api/genres', mod.genresRouter);
  app.use('/api/admin/genre-urls', mod.adminGenreUrlsRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try { return await fn(`http://localhost:${port}`); }
  finally { server.close(); }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/genres/:slug/urls', () => {
  beforeEach(() => {
    state.urls.push(
      { id: 'u1', genre_slug: 'ai-marketing', url: 'https://e.com/a', url_type: 'rss', visibility: 'public',  created_by_user_id: TEST_USER_OWNER, label: null, active: true, created_at: '', updated_at: '' },
      { id: 'u2', genre_slug: 'ai-marketing', url: 'https://e.com/b', url_type: 'rss', visibility: 'private', created_by_user_id: TEST_USER_OWNER, label: null, active: true, created_at: '', updated_at: '' },
      { id: 'u3', genre_slug: 'ai-marketing', url: 'https://e.com/c', url_type: 'rss', visibility: 'private', created_by_user_id: TEST_USER_OTHER, label: null, active: true, created_at: '', updated_at: '' },
    );
  });

  it('admin sees all rows for the genre', async () => {
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'superuser';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls`);
      expect(r.status).toBe(200);
      const j = await r.json() as { urls: { id: string }[] };
      expect(j.urls.map((x) => x.id).sort()).toEqual(['u1', 'u2', 'u3']);
    });
  });

  it('regular user sees public + own private, NOT others private', async () => {
    TEST_USER_ID = TEST_USER_OTHER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls`);
      const j = await r.json() as { urls: { id: string }[] };
      // u1 (public) + u3 (own); u2 hidden because owned by other user
      expect(j.urls.map((x) => x.id).sort()).toEqual(['u1', 'u3']);
    });
  });

  it('rejects bad slug shape', async () => {
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/Invalid_Slug/urls`);
      expect(r.status).toBe(400);
    });
  });
});

describe('POST /api/genres/:slug/urls', () => {
  it('regular user can add private URL', async () => {
    TEST_USER_ID = TEST_USER_OTHER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/feed', url_type: 'rss', label: 'My feed' }),
      });
      expect(r.status).toBe(201);
      const j = await r.json() as { url: { visibility: string; created_by_user_id: string } };
      expect(j.url.visibility).toBe('private');
      expect(j.url.created_by_user_id).toBe(TEST_USER_OTHER);
      expect(state.urls).toHaveLength(1);
    });
  });

  it('regular user CANNOT set visibility=public (403)', async () => {
    TEST_USER_ID = TEST_USER_OTHER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/feed', url_type: 'rss', visibility: 'public' }),
      });
      expect(r.status).toBe(403);
      expect(state.urls).toHaveLength(0); // never reached the DB
    });
  });

  it('admin can set visibility=public', async () => {
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'admin';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/feed', url_type: 'rss', visibility: 'public' }),
      });
      expect(r.status).toBe(201);
      expect(state.urls[0].visibility).toBe('public');
    });
  });

  it('superuser can set visibility=public', async () => {
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'superuser';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/feed', url_type: 'rss', visibility: 'public' }),
      });
      expect(r.status).toBe(201);
    });
  });

  it('rejects malformed URL', async () => {
    TEST_USER_ID = TEST_USER_OTHER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url', url_type: 'rss' }),
      });
      expect(r.status).toBe(400);
    });
  });

  it('rejects unsupported url_type', async () => {
    TEST_USER_ID = TEST_USER_OTHER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/x', url_type: 'tiktok' }),
      });
      expect(r.status).toBe(400);
    });
  });

  it('returns 409 on duplicate (same user + slug + type + url + visibility)', async () => {
    TEST_USER_ID = TEST_USER_OTHER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const body = { url: 'https://example.com/dup', url_type: 'rss' };
      const first = await fetch(`${base}/api/genres/ai-marketing/urls`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(first.status).toBe(201);
      const second = await fetch(`${base}/api/genres/ai-marketing/urls`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(second.status).toBe(409);
    });
  });
});

describe('DELETE /api/genres/:slug/urls/:id', () => {
  beforeEach(() => {
    state.urls.push(
      { id: 'aaaaaaaa-aaaa-4aaa-9aaa-000000000001', genre_slug: 'ai-marketing', url: 'https://e.com/a', url_type: 'rss', visibility: 'private', created_by_user_id: TEST_USER_OWNER, label: null, active: true, created_at: '', updated_at: '' },
      { id: 'aaaaaaaa-aaaa-4aaa-9aaa-000000000002', genre_slug: 'ai-marketing', url: 'https://e.com/b', url_type: 'rss', visibility: 'private', created_by_user_id: TEST_USER_OTHER, label: null, active: true, created_at: '', updated_at: '' },
    );
  });

  it('owner can delete their own row', async () => {
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls/aaaaaaaa-aaaa-4aaa-9aaa-000000000001`, { method: 'DELETE' });
      expect(r.status).toBe(200);
      expect(state.urls.find((x) => x.id === 'aaaaaaaa-aaaa-4aaa-9aaa-000000000001')).toBeUndefined();
    });
  });

  it('non-owner non-admin cannot delete (403)', async () => {
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls/aaaaaaaa-aaaa-4aaa-9aaa-000000000002`, { method: 'DELETE' });
      expect(r.status).toBe(403);
      expect(state.urls).toHaveLength(2); // nothing deleted
    });
  });

  it('admin can delete other users rows', async () => {
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'admin';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls/aaaaaaaa-aaaa-4aaa-9aaa-000000000002`, { method: 'DELETE' });
      expect(r.status).toBe(200);
    });
  });

  it('returns 404 for unknown id', async () => {
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'superuser';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/genres/ai-marketing/urls/aaaaaaaa-aaaa-4aaa-9aaa-999999999999`, { method: 'DELETE' });
      expect(r.status).toBe(404);
    });
  });
});

describe('GET /api/admin/genre-urls', () => {
  beforeEach(() => {
    state.urls.push(
      { id: 'u1', genre_slug: 'ai-marketing',     url: 'https://e.com/a', url_type: 'rss', visibility: 'public',  created_by_user_id: TEST_USER_OWNER, label: null, active: true, created_at: '', updated_at: '' },
      { id: 'u2', genre_slug: 'metaphysical-romance', url: 'https://e.com/b', url_type: 'rss', visibility: 'private', created_by_user_id: TEST_USER_OTHER, label: null, active: true, created_at: '', updated_at: '' },
    );
  });

  it('admin sees rows across all genres', async () => {
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'admin';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/admin/genre-urls`);
      expect(r.status).toBe(200);
      const j = await r.json() as { urls: unknown[] };
      expect(j.urls.length).toBe(2);
    });
  });

  it('regular user is rejected (403)', async () => {
    TEST_USER_ID = TEST_USER_OTHER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withGenresServer(async (base) => {
      const r = await fetch(`${base}/api/admin/genre-urls`);
      expect(r.status).toBe(403);
    });
  });
});
