/**
 * GET /api/newsletter/approvals/:token/preview — the rendered email shown on an approval.
 *
 * Found on DEV 2026-11-03 (Content Studio issue e2e-studio-lv3): only the stories gate carries the
 * stories, so the subject gate and the image gate (the last gate before the issue renders and goes out)
 * previewed "0 stories this issue". They now show the stories approved at the same run's stories gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Row, _res: unknown, next: () => void) => { req.userId = 'owner'; req.effectiveRole = 'user'; next(); },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSuperuser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let limit = Infinity;
    let desc: string | null = null;
    const run = () => {
      let rows = (db[table] ?? []).filter((r) => f.every((x) => x(r)));
      if (desc) rows = [...rows].sort((a, b) => String(b[desc!]).localeCompare(String(a[desc!])));
      return rows.slice(0, limit);
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      order: (c: string, o?: { ascending?: boolean }) => ((desc = o?.ascending === false ? c : null), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(ok),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from, rpc: async () => ({ data: 4, error: null }) }) };
});

const TEMPLATE = '<h1>{{preheader}}</h1><section class="lead">{{lead.headline}}</section><main>{{{markdown_to_html body_md}}}</main>';
const STORIES = [
  { title: 'Bravo first', summary: 'b', external_source_links: ['https://b'] },
  { title: 'Python second', summary: 'p', external_source_links: ['https://p'] },
  { title: 'Alpha third', summary: 'a', external_source_links: ['https://a'] },
];

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.newsletter_templates_v2 = [{ id: 't1', edition_id: 'ed', is_default: true, active: true, html: TEMPLATE, sample_data: {} }];
  db.newsletter_editions_v2 = [{ id: 'ed', newsletter_name: 'Ed' }];
  db.newsletter_approvals_v2 = [
    { token: 'tok-stories', user_id: 'owner', edition_id: 'ed', execution_id: 'ex1', stage: 'stories', created_at: '2026-11-03T14:53:00Z', payload: { top_selected_stories: STORIES } },
    { token: 'tok-subject', user_id: 'owner', edition_id: 'ed', execution_id: 'ex1', stage: 'subject_line', created_at: '2026-11-03T14:54:00Z', payload: { subject_line: 'S' } },
    { token: 'tok-image', user_id: 'owner', edition_id: 'ed', execution_id: 'ex1', stage: 'image', created_at: '2026-11-03T14:55:00Z', payload: { segments: [], image_options_by_story: [] } },
    // Another run's stories gate, and another user's, must not leak in.
    { token: 'tok-other-run', user_id: 'owner', edition_id: 'ed', execution_id: 'ex2', stage: 'stories', created_at: '2026-11-03T15:00:00Z', payload: { top_selected_stories: [{ title: 'Other run' }] } },
    { token: 'tok-theirs', user_id: 'other', edition_id: 'ed', execution_id: 'ex1', stage: 'stories', created_at: '2026-11-03T16:00:00Z', payload: { top_selected_stories: [{ title: 'Theirs' }] } },
  ];
});

async function preview(token: string): Promise<{ status: number; html: string }> {
  const { newsletterRouter } = await import('../routes/newsletter.js');
  const app = express(); app.use(express.json()); app.use('/api/newsletter', newsletterRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/api/newsletter/approvals/${token}/preview`);
    const json = (await r.json()) as { html?: string };
    return { status: r.status, html: json.html ?? '' };
  } finally { server.close(); }
}

describe('approval email preview', () => {
  it('shows the run\'s chosen stories at every gate, in order, with the first as the lead', async () => {
    for (const token of ['tok-stories', 'tok-subject', 'tok-image']) {
      const { status, html } = await preview(token);
      expect(status, token).toBe(200);
      expect(html, token).toContain('3 stories this issue');
      expect(html, token).toContain('<section class="lead">Bravo first</section>');
      expect(html.indexOf('Python second'), token).toBeLessThan(html.indexOf('Alpha third'));
      expect(html, token).not.toMatch(/Other run|Theirs/);
    }
  });

  it('is 404 for an approval that is not the caller\'s', async () => {
    expect((await preview('tok-theirs')).status).toBe(404);
  });
});
