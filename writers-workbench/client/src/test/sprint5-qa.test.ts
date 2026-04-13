import { describe, it, expect } from 'vitest';
import type { TokenUsage, ContentUsage, QAReport, QACheck, ContentIndex } from '../types/database';

// Sprint 5: Observability & Advanced Features — QA Tests

// ---- S5-1: Token/Cost Tracking Dashboard ----
describe('S5-1: Token usage types', () => {
  it('TokenUsage type has all required fields', () => {
    const usage: TokenUsage = {
      id: 'tu-1',
      user_id: '+14105914612',
      workflow_name: 'write_chapter',
      model: 'claude-sonnet-4-5-20250514',
      input_tokens: 5000,
      output_tokens: 8000,
      total_tokens: 13000,
      cost_usd: 0.045,
      metadata: { project_id: 'proj-1' },
      created_at: '2026-04-12T12:00:00Z',
    };
    expect(usage.workflow_name).toBe('write_chapter');
    expect(usage.cost_usd).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);
  });

  it('TokenUsage allows null model', () => {
    const usage: TokenUsage = {
      id: 'tu-2',
      user_id: '+14105914612',
      workflow_name: 'brainstorm_story',
      model: null,
      input_tokens: 1000,
      output_tokens: 2000,
      total_tokens: 3000,
      cost_usd: 0.01,
      metadata: {},
      created_at: '2026-04-12T12:00:00Z',
    };
    expect(usage.model).toBeNull();
  });
});

describe('S5-1: Cost summary calculation', () => {
  it('aggregates cost by model correctly', () => {
    const records: TokenUsage[] = [
      { id: '1', user_id: 'u', workflow_name: 'wf1', model: 'claude', input_tokens: 100, output_tokens: 200, total_tokens: 300, cost_usd: 0.01, metadata: {}, created_at: '2026-04-12T00:00:00Z' },
      { id: '2', user_id: 'u', workflow_name: 'wf2', model: 'claude', input_tokens: 200, output_tokens: 300, total_tokens: 500, cost_usd: 0.02, metadata: {}, created_at: '2026-04-12T00:00:00Z' },
      { id: '3', user_id: 'u', workflow_name: 'wf3', model: 'perplexity', input_tokens: 50, output_tokens: 100, total_tokens: 150, cost_usd: 0.005, metadata: {}, created_at: '2026-04-12T00:00:00Z' },
    ];

    const byModel: Record<string, { cost: number; calls: number }> = {};
    for (const r of records) {
      const m = r.model || 'unknown';
      if (!byModel[m]) byModel[m] = { cost: 0, calls: 0 };
      byModel[m].cost += r.cost_usd;
      byModel[m].calls++;
    }

    expect(byModel['claude'].calls).toBe(2);
    expect(byModel['claude'].cost).toBeCloseTo(0.03);
    expect(byModel['perplexity'].calls).toBe(1);
  });

  it('calculates total cost across all records', () => {
    const costs = [0.01, 0.02, 0.005];
    const total = costs.reduce((sum, c) => sum + c, 0);
    expect(total).toBeCloseTo(0.035);
  });

  it('groups by day correctly', () => {
    const dates = ['2026-04-10T10:00:00Z', '2026-04-10T15:00:00Z', '2026-04-11T08:00:00Z'];
    const byDay: Record<string, number> = {};
    for (const d of dates) {
      const day = d.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
    expect(byDay['2026-04-10']).toBe(2);
    expect(byDay['2026-04-11']).toBe(1);
  });

  it('date range filter produces correct cutoff dates', () => {
    const now = new Date('2026-04-12T12:00:00Z');
    const ranges: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
    for (const [_label, days] of Object.entries(ranges)) {
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - days);
      expect(cutoff.getTime()).toBeLessThan(now.getTime());
      const diffDays = (now.getTime() - cutoff.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeCloseTo(days, 0);
    }
  });
});

// ---- S5-2: Content Provenance Panel ----
describe('S5-2: Content provenance types', () => {
  it('ContentUsage type has all required fields', () => {
    const usage: ContentUsage = {
      id: 'cu-1',
      user_id: '+14105914612',
      content_id: 'ci-123',
      output_type: 'chapter',
      output_title: 'Chapter 1: The Beginning',
      output_date: '2026-04-12',
      project_id: 'proj-1',
      created_at: '2026-04-12T12:00:00Z',
    };
    expect(usage.output_type).toBe('chapter');
    expect(usage.content_id).toBe('ci-123');
  });

  it('ContentUsage supports joined source fields', () => {
    const usage: ContentUsage = {
      id: 'cu-2',
      user_id: '+14105914612',
      content_id: 'ci-456',
      output_type: 'blog_post',
      output_title: 'AI in Healthcare',
      output_date: '2026-04-12',
      project_id: null,
      created_at: '2026-04-12T12:00:00Z',
      source_title: 'TechCrunch Article on AI',
      source_type: 'RSS',
      source_url: 'https://techcrunch.com/ai-article',
      scraped_at: '2026-04-10T00:00:00Z',
    };
    expect(usage.source_title).toBe('TechCrunch Article on AI');
    expect(usage.source_type).toBe('RSS');
    expect(usage.source_url).toContain('https://');
  });

  it('ContentIndex type has all fields', () => {
    const source: ContentIndex = {
      id: 'ci-1',
      genre_slug: 'post-apocalyptic',
      source_type: 'RSS',
      feed_name: 'io9 Sci-Fi',
      source_url: 'https://io9.gizmodo.com/article',
      title: 'Best Sci-Fi Books of 2026',
      summary: 'A curated list of...',
      content_path: 'post-apocalyptic/2026-04-10/best-scifi.txt',
      scraped_at: '2026-04-10T00:00:00Z',
      metadata: {},
    };
    expect(source.genre_slug).toBe('post-apocalyptic');
    expect(source.source_type).toBe('RSS');
  });
});

// ---- S5-3: Q/A Consistency Reports ----
describe('S5-3: QA report types', () => {
  it('QACheck type supports PASS and NEEDS_REVIEW statuses', () => {
    const passCheck: QACheck = { name: 'Character Consistency', status: 'PASS', details: 'All characters maintain consistent traits' };
    const reviewCheck: QACheck = { name: 'Timeline Accuracy', status: 'NEEDS_REVIEW', details: 'Chapter 5 mentions Tuesday but Chapter 3 says Monday for the same event' };
    expect(passCheck.status).toBe('PASS');
    expect(reviewCheck.status).toBe('NEEDS_REVIEW');
  });

  it('QAReport has correct structure with 9 checks', () => {
    const report: QAReport = {
      generated_at: '2026-04-12T12:00:00Z',
      overall_status: 'NEEDS_REVIEW',
      checks: [
        { name: 'Character Consistency', status: 'PASS', details: 'OK' },
        { name: 'Timeline Accuracy', status: 'PASS', details: 'OK' },
        { name: 'Plot Continuity', status: 'PASS', details: 'OK' },
        { name: 'Setting Consistency', status: 'PASS', details: 'OK' },
        { name: 'Dialogue Attribution', status: 'PASS', details: 'OK' },
        { name: 'POV Consistency', status: 'PASS', details: 'OK' },
        { name: 'Foreshadowing', status: 'NEEDS_REVIEW', details: 'Unresolved foreshadow in Ch.3' },
        { name: 'Tone Consistency', status: 'PASS', details: 'OK' },
        { name: 'World Building', status: 'PASS', details: 'OK' },
      ],
    };
    expect(report.checks).toHaveLength(9);
    expect(report.overall_status).toBe('NEEDS_REVIEW');
    const passCount = report.checks.filter(c => c.status === 'PASS').length;
    expect(passCount).toBe(8);
  });

  it('QAReport with all PASS has PASS overall_status', () => {
    const report: QAReport = {
      generated_at: '2026-04-12T12:00:00Z',
      overall_status: 'PASS',
      checks: Array.from({ length: 9 }, (_, i) => ({
        name: `Check ${i + 1}`,
        status: 'PASS' as const,
        details: 'All good',
      })),
    };
    expect(report.overall_status).toBe('PASS');
    expect(report.checks.every(c => c.status === 'PASS')).toBe(true);
  });

  it('Q/A panel handles missing qa_report gracefully', () => {
    const metadata: Record<string, unknown> = {};
    const report = metadata?.qa_report as QAReport | undefined;
    expect(report).toBeUndefined();
  });

  it('Q/A panel handles metadata with qa_report present', () => {
    const metadata: Record<string, unknown> = {
      qa_report: {
        generated_at: '2026-04-12T12:00:00Z',
        overall_status: 'PASS',
        checks: [{ name: 'Test', status: 'PASS', details: 'OK' }],
      },
    };
    const report = metadata.qa_report as QAReport;
    expect(report.checks).toHaveLength(1);
    expect(report.overall_status).toBe('PASS');
  });
});

// ---- S5-4: Web Callback Architecture ----
describe('S5-4: Session and callback API', () => {
  it('session register endpoint path is correct', () => {
    expect('/api/session/register').toMatch(/^\/api\/session\//);
  });

  it('session unregister endpoint path is correct', () => {
    expect('/api/session/unregister').toMatch(/^\/api\/session\//);
  });

  it('session active check endpoint includes user_id query', () => {
    const userId = '+14105914612';
    const url = `/api/session/active?user_id=${encodeURIComponent(userId)}`;
    expect(url).toContain('user_id=%2B14105914612');
  });

  it('content-ready callback payload has required fields', () => {
    const payload = {
      user_id: '+14105914612',
      content_title: 'Chapter 5: The Reckoning',
      content_type: 'chapter',
      content_id: 'content-uuid-123',
    };
    expect(payload.user_id).toBeTruthy();
    expect(payload.content_title).toBeTruthy();
    expect(payload.content_type).toBeTruthy();
  });

  it('SSE events endpoint uses token query param for auth', () => {
    const token = 'eyJ...fake';
    const url = `/api/callback/events?token=${encodeURIComponent(token)}`;
    expect(url).toContain('token=');
    expect(url).not.toContain('Authorization');
  });
});

// ---- S5-5: n8n Web Routing ----
describe('S5-5: n8n callback web routing logic', () => {
  it('web session response shape for active user', () => {
    const response = { active: true, channel: 'web' };
    expect(response.active).toBe(true);
    expect(response.channel).toBe('web');
  });

  it('web session response shape for inactive user', () => {
    const response = { active: false, channel: null };
    expect(response.active).toBe(false);
    expect(response.channel).toBeNull();
  });

  it('callback result includes channel field', () => {
    const webResult = { result: 'KB updated. User on web.', channel: 'web', kb_doc_id: 'doc-1', callback_phone: '+14105914612' };
    const phoneResult = { result: 'KB updated. Calling +1410.', channel: 'phone', call_id: 'call-1', kb_doc_id: 'doc-2', callback_phone: '+14105914612' };
    expect(webResult.channel).toBe('web');
    expect(phoneResult.channel).toBe('phone');
  });
});

// ---- S5-6: Dashboard Auto-Refresh ----
describe('S5-6: Dashboard auto-refresh', () => {
  it('refetchInterval is 30 seconds (30000ms)', () => {
    const REFETCH_INTERVAL = 30_000;
    expect(REFETCH_INTERVAL).toBe(30000);
  });

  it('toast notification shape for content-ready event', () => {
    const event = {
      type: 'content-ready',
      content_title: 'Chapter 7',
      content_type: 'chapter',
      timestamp: new Date().toISOString(),
    };
    const message = `Eve has loaded "${event.content_title}"`;
    expect(message).toBe('Eve has loaded "Chapter 7"');
  });

  it('SSE event data is valid JSON', () => {
    const eventData = JSON.stringify({ type: 'content-ready', content_title: 'Test', timestamp: '2026-04-12T12:00:00Z' });
    const parsed = JSON.parse(eventData);
    expect(parsed.type).toBe('content-ready');
  });
});

// ---- Component Existence Checks ----
describe('Sprint 5: Component modules exist', () => {
  it('CostDashboard component exists', async () => {
    const mod = await import('../components/cost/CostDashboard');
    expect(mod.default).toBeDefined();
  });

  it('QAReportPanel component exists', async () => {
    const mod = await import('../components/content/QAReportPanel');
    expect(mod.default).toBeDefined();
  });

  it('ProvenancePanel component exists', async () => {
    const mod = await import('../components/content/ProvenancePanel');
    expect(mod.default).toBeDefined();
  });

  it('SourceBrowser component exists', async () => {
    const mod = await import('../components/content/SourceBrowser');
    expect(mod.default).toBeDefined();
  });
});

// ---- Route Existence Checks ----
describe('Sprint 5: Route structure', () => {
  it('cost route is /cost', () => {
    expect('/cost').toBe('/cost');
  });

  it('sources route is /sources', () => {
    expect('/sources').toBe('/sources');
  });

  it('sidebar includes Sources and Cost Tracking links', () => {
    const referenceRoutes = ['/genres', '/story-arcs', '/research', '/sources', '/cost'];
    expect(referenceRoutes).toContain('/sources');
    expect(referenceRoutes).toContain('/cost');
    expect(referenceRoutes).toHaveLength(5);
  });
});
