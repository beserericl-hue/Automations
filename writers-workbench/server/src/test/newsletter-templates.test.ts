/**
 * Newsletter Templates Sprint (T2) — server tests.
 *
 * Two halves:
 *   1. Direct unit tests of the render lib (helpers + deepMerge + compile/render errors).
 *   2. Endpoint tests for /api/newsletter/templates and /preview, with an
 *      in-memory Supabase fake covering the chains the routes exercise.
 *
 * Auth is stubbed via vi.mock('../middleware/auth.js') with a setter that
 * lets each test flip role between user/admin/superuser.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  renderTemplate,
  TemplateCompileError,
  _internal,
} from '../lib/newsletter-render.js';

// =========================================================================
// 1. Render lib unit tests — no Supabase, no HTTP.
// =========================================================================

describe('newsletter-render — helpers + deepMerge', () => {
  it('rank helper pads to two digits', () => {
    const result = renderTemplate(
      '{{#each items}}[{{rank @index}}]{{/each}}',
      { items: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}] },
    );
    expect(result.html).toBe('[01][02][03][04][05][06][07][08][09][10]');
  });

  it('format_date helper formats a known date', () => {
    const result = renderTemplate(
      '{{format_date "2026-04-24T12:34:56Z" "MMM D, YYYY"}}',
      {},
    );
    expect(result.html).toMatch(/Apr 24, 2026/);
  });

  it('triple-stash passes through HTML for *_html fields', () => {
    const result = renderTemplate(
      '{{{intro_html}}}',
      { intro_html: '<p><strong>hi</strong></p>' },
    );
    expect(result.html).toBe('<p><strong>hi</strong></p>');
  });

  it('two-stash escapes HTML by default', () => {
    const result = renderTemplate(
      '{{name}}',
      { name: '<script>alert(1)</script>' },
    );
    expect(result.html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('deepMerge — runtime keys override fallback; missing keys keep fallback', () => {
    const merged = _internal.deepMerge(
      { a: 1, nested: { x: 'fallback', y: 'fallback' }, list: [1, 2, 3] },
      { nested: { y: 'runtime' }, list: [9] },
    ) as Record<string, unknown>;
    expect(merged.a).toBe(1); // kept from fallback
    expect((merged.nested as Record<string, unknown>).x).toBe('fallback');
    expect((merged.nested as Record<string, unknown>).y).toBe('runtime');
    expect(merged.list).toEqual([9]); // arrays replaced wholesale
  });

  it('deepMerge — runtime null replaces fallback object', () => {
    const merged = _internal.deepMerge({ a: { b: 1 } }, { a: null }) as Record<string, unknown>;
    expect(merged.a).toBeNull();
  });

  it('renderTemplate uses sampleData as fallback when runtime omits a section', () => {
    const tpl = '{{#if pull_quote}}<q>{{pull_quote.quote}}</q>{{/if}}';
    const result = renderTemplate(tpl, {}, { sampleData: { pull_quote: { quote: 'hi' } } });
    expect(result.html).toContain('<q>hi</q>');
  });

  it('renderTemplate runtime overrides sampleData', () => {
    const tpl = '{{lead.headline}}';
    const result = renderTemplate(
      tpl,
      { lead: { headline: 'real headline' } },
      { sampleData: { lead: { headline: 'sample headline' } } },
    );
    expect(result.html).toBe('real headline');
  });

  it('throws TemplateCompileError on a malformed template', () => {
    expect(() => renderTemplate('{{#if foo}}unterminated', {})).toThrow(TemplateCompileError);
  });

  it('renders the seeded Workbench template happily with sample data', () => {
    // Use a tiny snippet of the real seed — happy-path proof that the
    // helper set is sufficient for the actual newsletter shape.
    const tpl = `
      <h1>{{lead.headline}}</h1>
      <ul>{{#each trending.items}}<li>{{rank @index}} - {{title}} ({{source}})</li>{{/each}}</ul>
      {{#if signoff.signature_name}}<sig>— {{signoff.signature_name}}</sig>{{/if}}
    `;
    const result = renderTemplate(tpl, {
      lead: { headline: 'OpenAI ships privacy model' },
      trending: { items: [
        { title: 'Karpathy thread', source: 'X' },
        { title: 'Postal v3.3', source: 'postalserver.io' },
      ] },
      signoff: { signature_name: 'Eric' },
    });
    expect(result.html).toContain('OpenAI ships privacy model');
    expect(result.html).toContain('01 - Karpathy thread (X)');
    expect(result.html).toContain('02 - Postal v3.3 (postalserver.io)');
    expect(result.html).toContain('— Eric');
  });
});

// =========================================================================
// 2. Endpoint tests
// =========================================================================

const TEST_USER_OWNER = '+14105914612';
const TEST_USER_OTHER = '+17063338699';
let TEST_USER_ID = TEST_USER_OWNER;
let TEST_EFFECTIVE_ROLE: 'user' | 'admin' | 'superuser' = 'user';

interface FakeTpl {
  id: string;
  name: string;
  description: string | null;
  edition_id: string | null;
  user_id: string | null;
  source_type: 'system' | 'user';
  html: string;
  sample_data: Record<string, unknown>;
  is_default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const state: { rows: FakeTpl[]; forceUpdateError?: { code?: string; message: string } } = { rows: [] };

function reset() {
  state.rows = [];
  delete state.forceUpdateError;
  TEST_USER_ID = TEST_USER_OWNER;
  TEST_EFFECTIVE_ROLE = 'user';
}

function uuid(): string {
  // Hex-only random tail so the result satisfies Zod's strict UUID regex
  // (base36's letters g-z are not hex and would fail the 5th group).
  const tail = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return 'aaaaaaaa-bbbb-4ccc-9ddd-' + tail;
}

interface Filter { kind: 'eq' | 'is'; col: string; val: unknown }

function buildSelectBuilder() {
  const filters: Filter[] = [];
  const orFilters: string[] = [];
  function applyFilters(rows: FakeTpl[]): FakeTpl[] {
    let res = rows;
    for (const f of filters) {
      if (f.kind === 'eq') res = res.filter((r) => (r as unknown as Record<string, unknown>)[f.col] === f.val);
      if (f.kind === 'is' && f.val === null) res = res.filter((r) => (r as unknown as Record<string, unknown>)[f.col] == null);
    }
    if (orFilters.length > 0) {
      res = res.filter((r) => {
        for (const expr of orFilters) {
          for (const branch of expr.split(',')) {
            const isMatch = branch.match(/^([a-z_]+)\.is\.null$/);
            if (isMatch) {
              if ((r as unknown as Record<string, unknown>)[isMatch[1]] == null) return true;
              continue;
            }
            const eqMatch = branch.match(/^([a-z_]+)\.eq\.(.+)$/);
            if (eqMatch) {
              if ((r as unknown as Record<string, unknown>)[eqMatch[1]] === decodeURIComponent(eqMatch[2])) return true;
            }
          }
        }
        return false;
      });
    }
    return res;
  }

  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) { filters.push({ kind: 'eq', col, val }); return builder; },
    is(col: string, val: unknown) { filters.push({ kind: 'is', col, val }); return builder; },
    or(expr: string) { orFilters.push(expr); return builder; },
    order() { return builder; },
    maybeSingle() {
      const rows = applyFilters(state.rows);
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    single() {
      const rows = applyFilters(state.rows);
      if (rows.length === 0) return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
      return Promise.resolve({ data: rows[0], error: null });
    },
    then(onFulfilled: (x: { data: FakeTpl[] | null; error: unknown }) => unknown) {
      return Promise.resolve({ data: applyFilters(state.rows), error: null }).then(onFulfilled);
    },
  };
  return builder;
}

const fakeSupabase = {
  from(table: string) {
    if (table !== 'newsletter_templates_v2') throw new Error('unexpected table: ' + table);
    return {
      select: () => buildSelectBuilder(),
      insert: (row: Partial<FakeTpl>) => {
        // Enforce the partial-unique idx_newsletter_templates_v2_default
        // (one active default per non-null edition_id).
        if (row.is_default && row.active && row.edition_id) {
          const dup = state.rows.find((r) => r.is_default && r.active && r.edition_id === row.edition_id);
          if (dup) {
            return {
              select: () => ({
                single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate default' } }),
              }),
            };
          }
        }
        const newRow: FakeTpl = {
          id: row.id ?? uuid(),
          name: row.name ?? '',
          description: row.description ?? null,
          edition_id: row.edition_id ?? null,
          user_id: row.user_id === undefined ? null : row.user_id,
          source_type: (row.source_type ?? 'user') as 'system' | 'user',
          html: row.html ?? '',
          sample_data: row.sample_data ?? {},
          is_default: row.is_default ?? false,
          active: row.active ?? true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        state.rows.push(newRow);
        return {
          select: () => ({ single: () => Promise.resolve({ data: newRow, error: null }) }),
        };
      },
      update: (patch: Partial<FakeTpl>) => {
        const filters: Filter[] = [];
        const builder: Record<string, unknown> = {
          eq(col: string, val: unknown) { filters.push({ kind: 'eq', col, val }); return builder; },
          select() {
            if (state.forceUpdateError) {
              return { maybeSingle: () => Promise.resolve({ data: null, error: state.forceUpdateError }) };
            }
            const matched = state.rows.filter((r) => filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val));
            for (const row of matched) Object.assign(row, patch, { updated_at: new Date().toISOString() });
            return { maybeSingle: () => Promise.resolve({ data: matched[0] ?? null, error: null }) };
          },
        };
        return builder;
      },
      delete: () => {
        const filters: Filter[] = [];
        const builder: Record<string, unknown> = {
          eq(col: string, val: unknown) { filters.push({ kind: 'eq', col, val }); return builder; },
          then(onFulfilled: (x: { data: null; error: null }) => unknown) {
            state.rows = state.rows.filter((r) => !filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val));
            return Promise.resolve({ data: null, error: null }).then(onFulfilled);
          },
        };
        return builder;
      },
    };
  },
};

vi.mock('../services/supabase-admin.js', () => ({ getSupabaseAdmin: () => fakeSupabase }));

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
  requireSuperuser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

beforeEach(() => { reset(); });

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const mod = await import('../routes/newsletter.js');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/newsletter', mod.newsletterRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  try { return await fn(`http://localhost:${port}`); }
  finally { server.close(); }
}

const seed = (overrides: Partial<FakeTpl> = {}): FakeTpl => {
  const base: FakeTpl = {
    id: uuid(),
    name: 't',
    description: null,
    edition_id: 'ai-news',
    user_id: TEST_USER_OWNER,
    source_type: 'user',
    html: '<p>{{lead.headline}}</p>',
    sample_data: { lead: { headline: 'fallback headline' } },
    is_default: false,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  state.rows.push(base);
  return base;
};

// -------------------------------------------------------------------------
// GET /api/newsletter/templates
// -------------------------------------------------------------------------
describe('GET /api/newsletter/templates', () => {
  it('regular user sees system + own templates only', async () => {
    seed({ name: 'sys',     user_id: null });
    seed({ name: 'mine',    user_id: TEST_USER_OWNER });
    seed({ name: 'theirs',  user_id: TEST_USER_OTHER });
    TEST_EFFECTIVE_ROLE = 'user';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates`);
      expect(r.status).toBe(200);
      const j = await r.json() as { templates: { name: string }[] };
      expect(j.templates.map((t) => t.name).sort()).toEqual(['mine', 'sys']);
    });
  });

  it('admin sees everyone\'s templates', async () => {
    seed({ name: 'sys',     user_id: null });
    seed({ name: 'mine',    user_id: TEST_USER_OWNER });
    seed({ name: 'theirs',  user_id: TEST_USER_OTHER });
    TEST_EFFECTIVE_ROLE = 'admin';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates`);
      const j = await r.json() as { templates: unknown[] };
      expect(j.templates).toHaveLength(3);
    });
  });

  it('filters by edition_id', async () => {
    seed({ edition_id: 'ai-news', name: 'a' });
    seed({ edition_id: 'romance', name: 'b' });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates?edition_id=ai-news`);
      const j = await r.json() as { templates: { name: string }[] };
      expect(j.templates.map((t) => t.name)).toEqual(['a']);
    });
  });

  it('omits inactive by default; include_inactive=true returns them', async () => {
    seed({ active: true,  name: 'on' });
    seed({ active: false, name: 'off' });
    await withServer(async (base) => {
      const off = await fetch(`${base}/api/newsletter/templates`);
      const onlyOn = await off.json() as { templates: { name: string }[] };
      expect(onlyOn.templates.map((t) => t.name)).toEqual(['on']);

      const all = await fetch(`${base}/api/newsletter/templates?include_inactive=true`);
      const both = await all.json() as { templates: { name: string }[] };
      expect(both.templates.map((t) => t.name).sort()).toEqual(['off', 'on']);
    });
  });

  it('rejects malformed edition_id (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates?edition_id=Not_A_Slug`);
      expect(r.status).toBe(400);
    });
  });
});

// -------------------------------------------------------------------------
// POST /api/newsletter/templates
// -------------------------------------------------------------------------
describe('POST /api/newsletter/templates', () => {
  it('regular user creates an own template', async () => {
    TEST_EFFECTIVE_ROLE = 'user';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'mine', html: '<p>x</p>', edition_id: 'ai-news' }),
      });
      expect(r.status).toBe(201);
      const j = await r.json() as { template: { user_id: string; source_type: string } };
      expect(j.template.user_id).toBe(TEST_USER_OWNER);
      expect(j.template.source_type).toBe('user');
    });
  });

  it('regular user requesting source_type=system gets 403', async () => {
    TEST_EFFECTIVE_ROLE = 'user';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sys', html: '<p>x</p>', source_type: 'system' }),
      });
      expect(r.status).toBe(403);
      expect(state.rows).toHaveLength(0);
    });
  });

  it('admin creates a system template with user_id NULL', async () => {
    TEST_EFFECTIVE_ROLE = 'admin';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sys', html: '<p>x</p>', source_type: 'system' }),
      });
      expect(r.status).toBe(201);
      const j = await r.json() as { template: { user_id: string | null; source_type: string } };
      expect(j.template.user_id).toBeNull();
      expect(j.template.source_type).toBe('system');
    });
  });

  it('409 on duplicate active default for the same edition', async () => {
    seed({ edition_id: 'ai-news', is_default: true, active: true });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'second', html: '<p>x</p>', edition_id: 'ai-news', is_default: true }),
      });
      expect(r.status).toBe(409);
    });
  });

  it('rejects empty html (400)', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'mine', html: '' }),
      });
      expect(r.status).toBe(400);
    });
  });
});

// -------------------------------------------------------------------------
// DELETE /api/newsletter/templates/:id
// -------------------------------------------------------------------------
describe('DELETE /api/newsletter/templates/:id', () => {
  it('owner deletes their own', async () => {
    const row = seed({ user_id: TEST_USER_OWNER });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates/${row.id}`, { method: 'DELETE' });
      expect(r.status).toBe(200);
      expect(state.rows).toHaveLength(0);
    });
  });

  it('non-owner non-admin gets 403', async () => {
    const row = seed({ user_id: TEST_USER_OTHER });
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates/${row.id}`, { method: 'DELETE' });
      expect(r.status).toBe(403);
    });
  });

  it('refuses to delete an active default (409)', async () => {
    const row = seed({ user_id: TEST_USER_OWNER, is_default: true, active: true });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates/${row.id}`, { method: 'DELETE' });
      expect(r.status).toBe(409);
      expect(state.rows).toHaveLength(1);
    });
  });

  it('returns 404 for unknown id', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates/aaaaaaaa-bbbb-4ccc-9ddd-000000000000`, { method: 'DELETE' });
      expect(r.status).toBe(404);
    });
  });
});

// -------------------------------------------------------------------------
// POST /api/newsletter/templates/:id/preview
// -------------------------------------------------------------------------
describe('POST /api/newsletter/templates/:id/preview', () => {
  it('renders sample_data fallback when no body data is supplied', async () => {
    const row = seed({
      html: '<h1>{{lead.headline}}</h1>',
      sample_data: { lead: { headline: 'sample-fallback' } },
    });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates/${row.id}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { html: string };
      expect(j.html).toContain('<h1>sample-fallback</h1>');
    });
  });

  it('runtime data overrides sample_data', async () => {
    const row = seed({
      html: '<h1>{{lead.headline}}</h1>',
      sample_data: { lead: { headline: 'sample' } },
    });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates/${row.id}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { lead: { headline: 'real' } } }),
      });
      const j = await r.json() as { html: string };
      expect(j.html).toContain('<h1>real</h1>');
    });
  });

  it('400 on a malformed Handlebars template', async () => {
    const row = seed({ html: '{{#if foo}}unterminated', sample_data: {} });
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates/${row.id}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {} }),
      });
      expect(r.status).toBe(400);
      const j = await r.json() as { error: { code: string } };
      expect(j.error.code).toBe('TEMPLATE_COMPILE_ERROR');
    });
  });

  it('404 when caller cannot see the template (other user\'s private row)', async () => {
    const row = seed({ user_id: TEST_USER_OTHER });
    TEST_USER_ID = TEST_USER_OWNER;
    TEST_EFFECTIVE_ROLE = 'user';
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/newsletter/templates/${row.id}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {} }),
      });
      expect(r.status).toBe(404);
    });
  });
});
