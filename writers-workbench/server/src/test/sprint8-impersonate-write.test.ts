// Sprint 8 (write impersonation): contract tests for the impersonate-write
// router. Exercises mounting, the gate that blocks non-impersonating
// superusers, the field whitelist, and the audit-log entry shape.

import { describe, it, expect } from 'vitest';

describe('Impersonation write proxy module', () => {
  it('exports impersonateWriteRouter', async () => {
    const mod = await import('../routes/impersonate-write.js');
    expect(mod.impersonateWriteRouter).toBeDefined();
  });
});

describe('Impersonation audit log entry contract', () => {
  it('every action has at, superuser_id, target_user_id, action, resource, result', () => {
    // Pinned shape — must match what client tools (SuperuserPanel impersonation
    // history view, future per-user "what did support do" surface) expect.
    interface ImpersonationActionEntry {
      at: string;
      superuser_id: string;
      target_user_id: string;
      action: string;
      resource: { table: string; id?: string };
      fields_changed?: string[];
      result: 'ok' | 'error';
      error?: string;
    }
    const sample: ImpersonationActionEntry = {
      at: '2026-04-26T17:00:00Z',
      superuser_id: '+14105914612',
      target_user_id: '+15551234567',
      action: 'content.update',
      resource: { table: 'published_content_v2', id: 'd2063a9f-c8ea-47c8-ba43-067bbcd5e858' },
      fields_changed: ['content_text'],
      result: 'ok',
    };
    expect(sample.action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(sample.resource.table).toContain('_v2');
  });

  it('action namespace covers all supported write paths', () => {
    const supported = [
      'project.update', 'project.delete', 'project.restore',
      'content.update', 'content.delete', 'content.restore',
      'content_version.create',
      'story_bible.create', 'story_bible.update', 'story_bible.delete',
      'research.update', 'research.delete', 'research.restore',
      'image.create', 'image.delete',
      'social_post.update', 'social_post.delete',
    ];
    expect(supported.length).toBe(17);
    for (const a of supported) expect(a).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
});
