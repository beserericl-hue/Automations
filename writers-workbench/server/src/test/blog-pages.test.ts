/**
 * Blog posts on the open web.
 *
 * Asserted: the post's Markdown is rendered with raw HTML escaped and only http/https/mailto links
 * kept (a model wrote it; it runs on the Workbench's own domain); a draft cannot go public; a
 * published post gets a slug from its title that does not collide, keeps it, and is readable
 * without a login; and a post that is no longer approved, or was taken down, is a 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { postBodyHtml, renderPostPage } from '../lib/blog-page.js';

describe('rendering', () => {
  it('escapes raw HTML and drops unsafe links, keeping their text', () => {
    const html = postBodyHtml(
      'Hello <script>alert(1)</script> and <b>bold</b>.\n\n[ok](https://example.com) [bad](javascript:alert(1)) ![x](http://insecure.example/a.png)',
      'T',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<a href="https://example.com" rel="noopener nofollow">ok</a>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('bad');
    expect(html).not.toContain('<img');
  });

  it('drops a leading heading that repeats the title, and keeps the rest of the Markdown', () => {
    const html = postBodyHtml('# The Forgotten Engineers\n\nRome had **aqueducts**.\n\n## How', 'The Forgotten Engineers');
    expect(html).not.toContain('<h1>');
    expect(html).toContain('<strong>aqueducts</strong>');
    expect(html).toContain('<h2>How</h2>');
  });

  it('prints title, byline, date, and the book link when there is one', () => {
    const html = renderPostPage({
      title: 'A & B', author: 'Eric L Beser', publishedAt: '2026-10-26T12:00:00Z', markdown: 'Body.',
      canonicalUrl: 'https://w/blog/a-b', book: { title: 'The Ossuary', url: 'https://w/books/the-ossuary' },
    });
    expect(html).toContain('<h1>A &amp; B</h1>');
    expect(html).toContain('By Eric L Beser · October 26, 2026');
    expect(html).toContain('<link rel="canonical" href="https://w/blog/a-b">');
    expect(html).toContain('From the author of <a href="https://w/books/the-ossuary">The Ossuary</a>.');
  });
});

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => { req.userId = 'u1'; next(); },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../services/supabase-admin.js', () => {
  const get = (r: Row, path: string) => {
    if (path === 'metadata->web->>slug') return ((r.metadata as Row | null)?.web as Row | undefined)?.slug;
    return r[path];
  };
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => get(r, c) === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => get(r, c) !== v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(get(r, c))), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      update: (p: Row) => ((patch = p), q),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch) { for (const r of rows()) Object.assign(r, patch); return resolve({ error: null }); }
        resolve({ data: rows(), error: null });
      },
    };
    return q;
  };
  return {
    getSupabaseAdmin: () => ({ from, storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }) }) } }),
  };
});

beforeEach(() => {
  process.env.PUBLIC_APP_URL = 'https://writersworkbench-develop.up.railway.app';
  db.published_content_v2 = [
    { id: 'aaaaaa11-0000-0000-0000-000000000000', user_id: 'u1', content_type: 'blog_post', status: 'published', title: 'The Forgotten Engineers of Rome', content_text: '# The Forgotten Engineers of Rome\n\nWater.', project_id: 'p1', cover_image_path: null, deleted_at: null, metadata: {} },
    { id: 'bbbbbb22-0000-0000-0000-000000000000', user_id: 'u1', content_type: 'blog_post', status: 'draft', title: 'Draft', content_text: 'x', project_id: null, cover_image_path: null, deleted_at: null, metadata: {} },
    // Another author already holds the slug the first post would take.
    { id: 'cccccc33-0000-0000-0000-000000000000', user_id: 'u2', content_type: 'blog_post', status: 'published', title: 'Other', content_text: 'y', project_id: null, cover_image_path: null, deleted_at: null, metadata: { web: { slug: 'the-forgotten-engineers-of-rome', published_at: 'x' } } },
  ];
  db.author_profiles_v2 = [{ user_id: 'u1', pen_name: 'Eric L Beser' }];
  db.writing_projects_v2 = [{ id: 'p1', title: 'The Ossuary', deleted_at: null, pub: { slug: 'the-ossuary' } }];
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { blogPagesRouter, blogWebRouter } = await import('../routes/blog-pages.js');
  const app = express();
  app.use('/blog', blogPagesRouter);
  app.use('/api/content', blogWebRouter);
  const server = app.listen(0);
  try { return await fn(`http://localhost:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

describe('publishing a post', () => {
  it('refuses a draft', async () => {
    await withServer(async (base) => {
      const j = await fetch(`${base}/api/content/bbbbbb22-0000-0000-0000-000000000000/web`, { method: 'POST' }).then((r) => r.json() as Promise<any>); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(j.error.code).toBe('NOT_APPROVED');
    });
  });

  it('publishes at a slug that does not collide, keeps it, and serves it without a login', async () => {
    await withServer(async (base) => {
      const j = await fetch(`${base}/api/content/aaaaaa11-0000-0000-0000-000000000000/web`, { method: 'POST' }).then((r) => r.json() as Promise<any>); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(j.data.slug).toBe('the-forgotten-engineers-of-rome-aaaaaa');
      expect(j.data.url).toBe('https://writersworkbench-develop.up.railway.app/blog/the-forgotten-engineers-of-rome-aaaaaa');
      const again = await fetch(`${base}/api/content/aaaaaa11-0000-0000-0000-000000000000/web`, { method: 'POST' }).then((r) => r.json() as Promise<any>); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(again.data.slug).toBe(j.data.slug);
      const page = await fetch(`${base}/blog/${j.data.slug}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<h1>The Forgotten Engineers of Rome</h1>');
      expect(html).toContain('By Eric L Beser');
      expect(html).toContain('/books/the-ossuary');
    });
  });

  it('is gone once taken down, and once no longer approved', async () => {
    await withServer(async (base) => {
      const j = await fetch(`${base}/api/content/aaaaaa11-0000-0000-0000-000000000000/web`, { method: 'POST' }).then((r) => r.json() as Promise<any>); // eslint-disable-line @typescript-eslint/no-explicit-any
      db.published_content_v2[0].status = 'rejected';
      expect((await fetch(`${base}/blog/${j.data.slug}`)).status).toBe(404);
      db.published_content_v2[0].status = 'published';
      await fetch(`${base}/api/content/aaaaaa11-0000-0000-0000-000000000000/web`, { method: 'DELETE' });
      expect((await fetch(`${base}/blog/${j.data.slug}`)).status).toBe(404);
    });
  });
});
