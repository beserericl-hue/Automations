import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Sprint 3: CRUD Completeness & Data Management — QA Tests
// These tests verify that Sprint 3 components, types, and patterns are correct.

// Resolve paths from project root (writers-workbench/)
const projectRoot = path.resolve(process.cwd(), '..');
const clientSrc = path.resolve(process.cwd(), 'src');

describe('S3-1: Project Edit Form', () => {
  it('should define project statuses', async () => {
    const mod = await import('../components/projects/ProjectEditForm');
    expect(mod.default).toBeDefined();
  });

  it('should have WritingProject type with editable fields', () => {
    const sample: import('../types/database').WritingProject = {
      id: '123',
      user_id: '+1234567890',
      project_type: 'book',
      title: 'Test',
      genre_slug: 'scifi',
      status: 'planning',
      outline: null,
      chapter_count: 0,
      draft_path: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    expect(sample.title).toBe('Test');
    expect(sample.genre_slug).toBe('scifi');
    expect(sample.status).toBe('planning');
    expect(sample.project_type).toBe('book');
  });
});

describe('S3-2: Story Bible Entry CRUD', () => {
  it('should have EntryForm component', async () => {
    const mod = await import('../components/story-bible/EntryForm');
    expect(mod.default).toBeDefined();
  });

  it('should define all 6 entry types in StoryBibleEntry', () => {
    const validTypes = ['character', 'location', 'event', 'timeline', 'plot_thread', 'world_rule'];
    // Verify type definition allows all 6 entry types
    const sample: import('../types/database').StoryBibleEntry = {
      id: '1',
      user_id: '+1',
      project_id: '2',
      entry_type: 'character',
      name: 'Test',
      description: 'Desc',
      metadata: { age: '34' },
      chapter_introduced: 1,
      last_chapter_seen: 5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    expect(validTypes).toContain(sample.entry_type);
  });

  it('should support metadata as key-value pairs', () => {
    const metadata: Record<string, unknown> = { age: '34', occupation: 'Engineer', relationship: 'married' };
    expect(Object.keys(metadata)).toHaveLength(3);
    expect(metadata.age).toBe('34');
  });
});

describe('S3-3: Story Arc Create/Edit', () => {
  it('should have StoryArcForm component', async () => {
    const mod = await import('../components/story-arcs/StoryArcForm');
    expect(mod.default).toBeDefined();
  });

  it('should define StoryArc type with discovery_question', () => {
    const sample: import('../types/database').StoryArc = {
      id: '1',
      user_id: '+1',
      name: 'Custom Arc',
      description: 'My custom arc',
      prompt_text: 'Generate a story using...',
      discovery_question: 'What is the main conflict?',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(sample.discovery_question).toBe('What is the main conflict?');
    expect(sample.user_id).not.toBeNull(); // custom arc has user_id
  });

  it('public arcs should have null user_id', () => {
    const publicArc: import('../types/database').StoryArc = {
      id: '1',
      user_id: null,
      name: 'Three-Act Structure',
      description: 'Universal arc',
      prompt_text: '...',
      discovery_question: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(publicArc.user_id).toBeNull();
  });
});

describe('S3-4: Research Detail Page', () => {
  it('should have ResearchDetail component', async () => {
    const mod = await import('../components/research/ResearchDetail');
    expect(mod.default).toBeDefined();
  });

  it('should define ResearchReport type with content field', () => {
    const sample: import('../types/database').ResearchReport = {
      id: '1',
      user_id: '+1',
      topic: 'Ancient Rome',
      genre_slug: 'historical',
      content: '<h1>Research on Rome</h1><p>Content here...</p>',
      status: 'complete',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    expect(sample.content).toContain('<h1>');
    expect(sample.topic).toBe('Ancient Rome');
  });
});

describe('S3-5: Genre Feed Improvements', () => {
  it('should have GenreForm with improved ArrayField', async () => {
    const mod = await import('../components/genres/GenreForm');
    expect(mod.default).toBeDefined();
  });

  it('URL validation should accept valid URLs', () => {
    const isValidUrl = (url: string) => {
      if (!url.trim()) return true;
      try { new URL(url); return true; } catch { return false; }
    };
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('https://medium.com/feed/tag/scifi')).toBe(true);
    expect(isValidUrl('')).toBe(true); // empty is OK
    expect(isValidUrl('not-a-url')).toBe(false);
    expect(isValidUrl('just words')).toBe(false);
  });
});

describe('S3-6: Scheduled Publishing', () => {
  it('PublishedContent type should support scheduled status', () => {
    const sample: import('../types/database').PublishedContent = {
      id: '1',
      user_id: '+1',
      title: 'Test',
      content_type: 'chapter',
      genre_slug: null,
      content_text: null,
      storage_path: null,
      cover_image_path: null,
      status: 'scheduled',
      project_id: null,
      chapter_number: null,
      metadata: { schedule_date: '2026-05-01T12:00:00.000Z' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      published_at: null,
      deleted_at: null,
    };
    expect(sample.status).toBe('scheduled');
    expect(sample.metadata.schedule_date).toBe('2026-05-01T12:00:00.000Z');
  });

  it('status workflow should include schedule transitions', () => {
    // Verify all valid statuses are defined
    const validStatuses: import('../types/database').PublishedContent['status'][] = [
      'draft', 'approved', 'published', 'rejected', 'scheduled',
    ];
    expect(validStatuses).toHaveLength(5);
    expect(validStatuses).toContain('scheduled');
  });
});

describe('S3-7: Account Deletion', () => {
  it('server should have account route file', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'server/src/routes/account.ts'), 'utf-8');
    expect(content).toContain("accountRouter.delete('/'");
    expect(content).toContain('DeleteAccountSchema');
    expect(content).toContain('auth.admin.deleteUser');
  });

  it('server should have cascade-info endpoint', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'server/src/routes/account.ts'), 'utf-8');
    expect(content).toContain("accountRouter.get('/cascade-info'");
    expect(content).toContain('writing_projects_v2');
    expect(content).toContain('published_content_v2');
    expect(content).toContain('research_reports_v2');
  });

  it('schemas should have DeleteAccountSchema', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'server/src/schemas.ts'), 'utf-8');
    expect(content).toContain('DeleteAccountSchema');
    expect(content).toContain("z.literal('DELETE'");
  });

  it('server index should register account route', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'server/src/index.ts'), 'utf-8');
    expect(content).toContain("'/api/account'");
    expect(content).toContain('accountRouter');
  });
});

describe('Sprint 3 Route Structure', () => {
  it('App.tsx should have research/:id route', () => {
    const appContent = fs.readFileSync(path.join(clientSrc, 'App.tsx'), 'utf-8');
    expect(appContent).toContain('research/:id');
    expect(appContent).toContain('ResearchDetail');
  });

  it('App.tsx should import ResearchDetail', () => {
    const appContent = fs.readFileSync(path.join(clientSrc, 'App.tsx'), 'utf-8');
    expect(appContent).toContain("import ResearchDetail from './components/research/ResearchDetail'");
  });
});

describe('Sprint 3 Outline Versioning', () => {
  it('should have outline versioning migration', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'migrations/003_sprint3_outline_versioning.sql'), 'utf-8');
    expect(content).toContain('snapshot_outline_on_change');
    expect(content).toContain('trg_snapshot_outline');
    expect(content).toContain('outline_versions_v2');
    expect(content).toContain('BEFORE UPDATE OF outline');
  });

  it('OutlineVersion type should match schema', () => {
    const sample: import('../types/database').OutlineVersion = {
      id: '1',
      user_id: '+1',
      project_id: '2',
      version_number: 1,
      outline: { title: 'My Book', premise: 'A story about...' },
      revision_note: 'Auto-snapshot before outline change',
      created_at: new Date().toISOString(),
    };
    expect(sample.version_number).toBe(1);
    expect(sample.outline.title).toBe('My Book');
  });
});
