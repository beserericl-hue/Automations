import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// -----------------------------------------------------------------------------
// In-memory Supabase admin fake
//
// Covers exactly the chain methods and storage ops that routes/ingestion.ts
// uses. A full stub of @supabase/supabase-js is out of scope; this mirrors
// Supabase's query-builder surface only as far as the ingestion route reaches.
// -----------------------------------------------------------------------------

interface FakeRow {
  id: string;
  key: string;
  user_id: string;
  type: string;
  title: string | null;
  authors: string | null;
  source_name: string;
  source_url: string | null;
  external_source_urls: unknown[];
  image_urls: unknown[];
  reddit_metadata: unknown;
  published_timestamp: string | null;
  feed_url: string | null;
  storage_path_md: string;
  storage_path_html: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FakeState {
  rows: FakeRow[];
  blobs: Map<string, string>;
  validUserIds: Set<string>;
  // Knobs to drive failure-path tests
  forceUploadError?: string;                  // bucket upload throws this message
  forceUploadErrorFor?: 'md' | 'html';        // which one fails (default: both)
  forceDownloadMissing?: boolean;             // storage.download returns error
  forceDbQueryError?: string;                 // select/upsert returns error
}

const state: FakeState = {
  rows: [],
  blobs: new Map(),
  validUserIds: new Set(['+14105914612']),
};

function resetState() {
  state.rows = [];
  state.blobs = new Map();
  state.validUserIds = new Set(['+14105914612']);
  delete state.forceUploadError;
  delete state.forceUploadErrorFor;
  delete state.forceDownloadMissing;
  delete state.forceDbQueryError;
}

function randomId() {
  return `fake-${Math.random().toString(36).slice(2)}`;
}

function rowsFilteredBy(filters: Record<string, unknown>, notFilters: Record<string, unknown>, nulls: Set<string>, prefix?: string) {
  return state.rows.filter((r) => {
    for (const k of Object.keys(filters)) {
      if ((r as unknown as Record<string, unknown>)[k] !== filters[k]) return false;
    }
    for (const k of Object.keys(notFilters)) {
      if ((r as unknown as Record<string, unknown>)[k] === notFilters[k]) return false;
    }
    for (const k of nulls) {
      if ((r as unknown as Record<string, unknown>)[k] !== null) return false;
    }
    if (prefix !== undefined && !r.key.startsWith(prefix.replace(/%$/, ''))) return false;
    return true;
  });
}

function buildSelectBuilder() {
  const filters: Record<string, unknown> = {};
  const notFilters: Record<string, unknown> = {};
  const nulls = new Set<string>();
  let likePrefix: string | undefined;

  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters[col] = val; return builder; },
    neq(col: string, val: unknown) { notFilters[col] = val; return builder; },
    is(col: string, val: unknown) { if (val === null) nulls.add(col); return builder; },
    like(col: string, pattern: string) { if (col === 'key') likePrefix = pattern; return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle() {
      if (state.forceDbQueryError) {
        return Promise.resolve({ data: null, error: { message: state.forceDbQueryError } });
      }
      const matches = rowsFilteredBy(filters, notFilters, nulls, likePrefix);
      return Promise.resolve({ data: matches[0] || null, error: null });
    },
    then(onFulfilled: (x: { data: FakeRow[] | null; error: { message: string } | null }) => unknown) {
      if (state.forceDbQueryError) {
        return Promise.resolve({ data: null, error: { message: state.forceDbQueryError } }).then(onFulfilled);
      }
      const matches = rowsFilteredBy(filters, notFilters, nulls, likePrefix);
      return Promise.resolve({ data: matches, error: null }).then(onFulfilled);
    },
  };
  return builder;
}

function buildTableBuilder(table: string) {
  return {
    select(_cols: string) {
      if (table !== 'content_ingestion_v2') throw new Error(`Unexpected table: ${table}`);
      return buildSelectBuilder();
    },
    async upsert(row: Partial<FakeRow>, _opts: { onConflict?: string }) {
      if (table !== 'content_ingestion_v2') throw new Error(`Unexpected table: ${table}`);
      if (state.forceDbQueryError) return { error: { message: state.forceDbQueryError, code: '99999' } };
      if (row.user_id && !state.validUserIds.has(row.user_id)) {
        return { error: { message: 'FK violation on user_id', code: '23503' } };
      }
      const now = new Date().toISOString();
      const existing = state.rows.findIndex((r) => r.key === row.key);
      const base: FakeRow = {
        id: randomId(),
        key: row.key!,
        user_id: row.user_id!,
        type: row.type!,
        title: row.title ?? null,
        authors: row.authors ?? null,
        source_name: row.source_name ?? '',
        source_url: row.source_url ?? null,
        external_source_urls: (row.external_source_urls as unknown[]) ?? [],
        image_urls: (row.image_urls as unknown[]) ?? [],
        reddit_metadata: row.reddit_metadata ?? null,
        published_timestamp: row.published_timestamp ?? null,
        feed_url: row.feed_url ?? null,
        storage_path_md: row.storage_path_md!,
        storage_path_html: row.storage_path_html!,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      };
      if (existing >= 0) {
        state.rows[existing] = { ...state.rows[existing], ...base, id: state.rows[existing].id, created_at: state.rows[existing].created_at };
      } else {
        state.rows.push(base);
      }
      return { error: null };
    },
  };
}

function buildStorageBucket() {
  return {
    async upload(path: string, buf: Buffer | Uint8Array) {
      if (state.forceUploadError) {
        const shouldFail =
          state.forceUploadErrorFor === undefined
          || (state.forceUploadErrorFor === 'md' && path.endsWith('.md'))
          || (state.forceUploadErrorFor === 'html' && path.endsWith('.html'));
        if (shouldFail) {
          return { error: { message: state.forceUploadError } };
        }
      }
      state.blobs.set(path, Buffer.from(buf).toString('utf-8'));
      return { error: null };
    },
    async download(path: string) {
      if (state.forceDownloadMissing || !state.blobs.has(path)) {
        return { data: null, error: { message: 'Object not found' } };
      }
      const content = state.blobs.get(path)!;
      return { data: { text: async () => content }, error: null };
    },
    async remove(paths: string[]) {
      for (const p of paths) state.blobs.delete(p);
      return { error: null };
    },
  };
}

const fakeSupabase = {
  from: (table: string) => buildTableBuilder(table),
  storage: { from: (_bucket: string) => buildStorageBucket() },
};

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => fakeSupabase,
}));

// -----------------------------------------------------------------------------
// Test harness
// -----------------------------------------------------------------------------

const TEST_SECRET = 'test-ingestion-secret-9x2';

async function loadRouter() {
  // Import after env + mocks are set up so the module picks up TEST_SECRET.
  const mod = await import('../routes/ingestion.js');
  return mod.ingestionRouter;
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const router = await loadRouter();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/ingestion', router);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://localhost:${port}/api/ingestion`);
  } finally {
    server.close();
  }
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    key: '2026-04-21/ex-meta-engineer.techcrunch',
    user_id: '+14105914612',
    type: 'article',
    title: 'Ex-Meta engineer raises $14M',
    source_name: 'techcrunch',
    source_url: 'https://techcrunch.com/example',
    external_source_urls: [],
    image_urls: [],
    published_timestamp: new Date().toISOString(),
    feed_url: 'https://techcrunch.com/feed',
    markdown: '# Hello\n\nBody text',
    html: '<h1>Hello</h1><p>Body text</p>',
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Ingestion endpoints (S3)', () => {
  beforeEach(() => {
    resetState();
    process.env.INGESTION_SECRET = TEST_SECRET;
  });

  // ---- auth / validation (no DB required) ----
  it('rejects POST /upload without X-Ingestion-Secret (401)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody()),
      });
      expect(r.status).toBe(401);
      const body = await r.json() as { success: boolean; error: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });
  });

  it('rejects POST /upload with wrong X-Ingestion-Secret (401)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': 'wrong' },
        body: JSON.stringify(validBody()),
      });
      expect(r.status).toBe(401);
    });
  });

  it('returns 500 if INGESTION_SECRET is unset on the server', async () => {
    delete process.env.INGESTION_SECRET;
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': 'x' },
        body: JSON.stringify(validBody()),
      });
      expect(r.status).toBe(500);
      const body = await r.json() as { error: { code: string } };
      expect(body.error.code).toBe('MISCONFIGURED');
    });
  });

  it('rejects path traversal attempts on /upload (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(validBody({ key: '../../etc/passwd' })),
      });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  it('rejects null byte in key on /upload (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(validBody({ key: 'foo\u0000bar' })),
      });
      expect(r.status).toBe(400);
    });
  });

  it('rejects .md/.html suffix in key (server appends, caller must not) (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(validBody({ key: '2026-04-21/slug.src.md' })),
      });
      expect(r.status).toBe(400);
    });
  });

  it('returns field-level 400 when required body field missing', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify({ ...validBody(), source_name: undefined }),
      });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: { code: string; fields: Array<{ field: string }> } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.fields.map((f) => f.field)).toContain('source_name');
    });
  });

  it('rejects invalid type enum value (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(validBody({ type: 'podcast' })),
      });
      expect(r.status).toBe(400);
    });
  });

  // ---- happy path roundtrip ----
  it('upload -> search -> get round-trip succeeds', async () => {
    await withServer(async (base) => {
      const body = validBody();

      const up = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(body),
      });
      expect(up.status).toBe(200);
      const upJson = await up.json() as { success: boolean; key: string };
      expect(upJson.success).toBe(true);
      expect(upJson.key).toBe(body.key);

      const search = await fetch(
        `${base}/search?prefix=${encodeURIComponent('2026-04-21/')}&user_id=${encodeURIComponent(body.user_id)}`,
        { headers: { 'X-Ingestion-Secret': TEST_SECRET } },
      );
      expect(search.status).toBe(200);
      const searchJson = await search.json() as { items: Array<{ key: string; title: string | null }> };
      expect(searchJson.items).toHaveLength(1);
      expect(searchJson.items[0].key).toBe(body.key);
      expect(searchJson.items[0].title).toBe(body.title);

      const get = await fetch(`${base}/get/${encodeURIComponent(body.key)}`, {
        headers: { 'X-Ingestion-Secret': TEST_SECRET },
      });
      expect(get.status).toBe(200);
      const getJson = await get.json() as { key: string; markdown: string; html: string };
      expect(getJson.key).toBe(body.key);
      expect(getJson.markdown).toBe(body.markdown);
      expect(getJson.html).toBe(body.html);
    });
  });

  it('search prefix filter returns only matching rows', async () => {
    await withServer(async (base) => {
      const mk = async (key: string) => fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(validBody({ key })),
      });
      await mk('2026-04-21/a.src');
      await mk('2026-04-21/b.src');
      await mk('2026-04-22/c.src');

      const today = await fetch(`${base}/search?prefix=2026-04-21/&user_id=%2B14105914612`, {
        headers: { 'X-Ingestion-Secret': TEST_SECRET },
      });
      const todayJson = await today.json() as { items: Array<{ key: string }> };
      expect(todayJson.items).toHaveLength(2);
      expect(todayJson.items.map((i) => i.key).sort()).toEqual(['2026-04-21/a.src', '2026-04-21/b.src']);
    });
  });

  it('search type_not excludes matching type', async () => {
    await withServer(async (base) => {
      const mk = async (key: string, type: string) => fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(validBody({ key, type })),
      });
      await mk('2026-04-21/a.src', 'article');
      await mk('2026-04-21/b.src', 'newsletter');
      await mk('2026-04-21/c.src', 'reddit_post');

      const r = await fetch(
        `${base}/search?prefix=2026-04-21/&user_id=%2B14105914612&type_not=newsletter`,
        { headers: { 'X-Ingestion-Secret': TEST_SECRET } },
      );
      const j = await r.json() as { items: Array<{ key: string; type: string }> };
      expect(j.items.map((i) => i.type).sort()).toEqual(['article', 'reddit_post']);
    });
  });

  it('re-upload with same key upserts (no duplicate row, blobs replaced)', async () => {
    await withServer(async (base) => {
      const body = validBody({ markdown: 'first', html: '<p>first</p>' });

      await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(body),
      });

      await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify({ ...body, markdown: 'second', html: '<p>second</p>', title: 'updated' }),
      });

      expect(state.rows).toHaveLength(1);
      const get = await fetch(`${base}/get/${encodeURIComponent(body.key)}`, {
        headers: { 'X-Ingestion-Secret': TEST_SECRET },
      });
      const j = await get.json() as { markdown: string; html: string; title: string };
      expect(j.markdown).toBe('second');
      expect(j.html).toBe('<p>second</p>');
      expect(j.title).toBe('updated');
    });
  });

  it('get with unknown key returns 404', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/get/${encodeURIComponent('2026-04-21/nothing.src')}`, {
        headers: { 'X-Ingestion-Secret': TEST_SECRET },
      });
      expect(r.status).toBe(404);
      const body = await r.json() as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  it('get returns 500 when row exists but blobs are missing from storage', async () => {
    await withServer(async (base) => {
      const body = validBody({ key: '2026-04-21/orphan.src' });
      await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(body),
      });

      // Simulate storage corruption / wipe while the row still exists.
      state.blobs.clear();
      state.forceDownloadMissing = true;

      const r = await fetch(`${base}/get/${encodeURIComponent(body.key)}`, {
        headers: { 'X-Ingestion-Secret': TEST_SECRET },
      });
      expect(r.status).toBe(500);
      const j = await r.json() as { error: { code: string; message: string } };
      expect(j.error.code).toBe('BLOB_MISSING');
      expect(j.error.message).toMatch(/blob is missing/i);
    });
  });

  it('upload with user_id not in users_v2 surfaces as 400 FK_VIOLATION', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(validBody({ user_id: '+19999999999' })),
      });
      expect(r.status).toBe(400);
      const j = await r.json() as { error: { code: string } };
      expect(j.error.code).toBe('FK_VIOLATION');
    });
  });

  it('upload path-traversal guard still runs at the route level (belt+braces)', async () => {
    // Kept as a live test so the defensive check in the route is exercised
    // even if the Zod schema's regex were ever relaxed in future.
    await withServer(async (base) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Secret': TEST_SECRET },
        body: JSON.stringify(validBody({ key: '/absolute/path' })),
      });
      expect(r.status).toBe(400);
    });
  });

  it('get rejects path traversal on the :key param (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/get/${encodeURIComponent('../../secret')}`, {
        headers: { 'X-Ingestion-Secret': TEST_SECRET },
      });
      expect(r.status).toBe(400);
      const j = await r.json() as { error: { code: string } };
      expect(j.error.code).toBe('INVALID_KEY');
    });
  });
});
