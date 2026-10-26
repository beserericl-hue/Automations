/**
 * Blog posts on the open web.
 *
 *   GET    /blog/:slug               the post, public, no login (mounted before CORS, like /books)
 *   POST   /api/content/:id/web      publish an approved or published post at /blog/<slug>
 *   DELETE /api/content/:id/web      take it down
 *
 * Where it is published lives in the post's own metadata (`metadata.web = {slug, published_at}`),
 * so no base table changes. The slug comes from the title and is kept once chosen, so the address
 * does not move if the title is edited afterwards. A draft cannot go public: a post is checked and
 * approved first, and taking the approval away (deleting or rejecting it) takes the page down too,
 * because the page only shows posts that are still approved or published.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';
import { renderPostPage } from '../lib/blog-page.js';
import { slugify } from '../lib/landing-page.js';

export const blogPagesRouter = Router();
export const blogWebRouter = Router();

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLIC_STATUSES = ['approved', 'published'];

interface PostRow {
  id: string;
  user_id: string;
  title: string | null;
  content_text: string | null;
  status: string | null;
  project_id: string | null;
  cover_image_path: string | null;
  created_at: string;
  metadata: { web?: { slug: string; published_at: string }; meta_description?: string } | null;
}

function base(req: Request): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  const host = req.get('x-forwarded-host') ?? req.get('host') ?? '';
  const proto = req.get('x-forwarded-proto')?.split(',')[0] ?? req.protocol;
  return `${proto}://${host}`;
}

function coverUrl(path: string | null): string | undefined {
  if (!path) return undefined;
  return getSupabaseAdmin().storage.from('cover-images').getPublicUrl(path).data.publicUrl;
}

function notFound(res: Response): void {
  res
    .status(404)
    .type('html')
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Post not found</title><style>body{font:18px/1.6 Georgia,serif;max-width:560px;margin:80px auto;padding:0 16px;color:#2b211b;background:#f6f0e6}</style>' +
        '</head><body><h1>This post is not available</h1><p>It has not been published, or it has been taken down.</p></body></html>',
    );
}

blogPagesRouter.get('/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  if (!SLUG.test(slug) || slug.length > 100) return notFound(res);
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from('published_content_v2')
      .select('id, user_id, title, content_text, status, project_id, cover_image_path, created_at, metadata')
      .eq('metadata->web->>slug', slug)
      .eq('content_type', 'blog_post')
      .in('status', PUBLIC_STATUSES)
      .is('deleted_at', null)
      .limit(1);
    const post = (data ?? [])[0] as PostRow | undefined;
    if (!post?.content_text?.trim() || !post.metadata?.web) return notFound(res);

    const { data: profile } = await supabase.from('author_profiles_v2').select('pen_name').eq('user_id', post.user_id).maybeSingle();
    let book: { title: string; url: string } | undefined;
    if (post.project_id) {
      const { data: project } = await supabase
        .from('writing_projects_v2')
        .select('title, pub:outline->_landing_page_public')
        .eq('id', post.project_id)
        .is('deleted_at', null)
        .maybeSingle();
      const pubSlug = (project?.pub as { slug?: string } | null)?.slug;
      if (project && pubSlug) book = { title: String(project.title), url: `${base(req)}/books/${pubSlug}` };
    }
    const html = renderPostPage({
      title: String(post.title ?? ''),
      author: String(profile?.pen_name ?? '').trim(),
      publishedAt: post.metadata.web.published_at,
      markdown: post.content_text,
      description: post.metadata.meta_description,
      coverUrl: coverUrl(post.cover_image_path),
      canonicalUrl: `${base(req)}/blog/${slug}`,
      book,
    });
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (err) {
    logger.error({ err, slug }, 'blog-page: render failed');
    res.status(500).type('text').send('This post could not be loaded. Please try again shortly.');
  }
});

// ------------------------------------------------------------------------------------------------

blogWebRouter.use(requireAuth);

async function loadPost(req: Request, res: Response): Promise<PostRow | null> {
  const { data } = await getSupabaseAdmin()
    .from('published_content_v2')
    .select('id, user_id, title, content_text, status, project_id, cover_image_path, created_at, metadata, content_type')
    .eq('id', String(req.params.id))
    .eq('user_id', req.userId!)
    .is('deleted_at', null)
    .maybeSingle();
  if (!data || (data as { content_type?: string }).content_type !== 'blog_post') {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Blog post not found' } });
    return null;
  }
  return data as PostRow;
}

async function slugTaken(slug: string, id: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('published_content_v2')
    .select('id')
    .eq('metadata->web->>slug', slug)
    .neq('id', id)
    .limit(1);
  return Boolean((data ?? []).length);
}

blogWebRouter.post('/:id/web', async (req: Request, res: Response) => {
  const post = await loadPost(req, res);
  if (!post) return;
  if (!PUBLIC_STATUSES.includes(String(post.status))) {
    res.status(409).json({ success: false, error: { code: 'NOT_APPROVED', message: 'Approve the post first. A draft cannot go on the web.' } });
    return;
  }
  try {
    let web = post.metadata?.web;
    if (!web) {
      let slug = slugify(String(post.title ?? ''), 80);
      if (await slugTaken(slug, post.id)) slug = `${slug}-${post.id.slice(0, 6)}`;
      web = { slug, published_at: new Date().toISOString() };
      const { error } = await getSupabaseAdmin()
        .from('published_content_v2')
        .update({ metadata: { ...(post.metadata ?? {}), web }, updated_at: new Date().toISOString() })
        .eq('id', post.id)
        .eq('user_id', req.userId!);
      if (error) throw new Error(error.message);
      logger.info({ userId: req.userId, contentId: post.id, slug }, 'blog-page: published');
    }
    res.json({ success: true, data: { ...web, url: `${base(req)}/blog/${web.slug}` } });
  } catch (err) {
    logger.error({ err, contentId: post.id }, 'blog-page: publish failed');
    res.status(500).json({ success: false, error: { code: 'PUBLISH_FAILED', message: 'Could not publish the post.' } });
  }
});

blogWebRouter.delete('/:id/web', async (req: Request, res: Response) => {
  const post = await loadPost(req, res);
  if (!post) return;
  const meta = { ...(post.metadata ?? {}) };
  delete meta.web;
  await getSupabaseAdmin()
    .from('published_content_v2')
    .update({ metadata: meta, updated_at: new Date().toISOString() })
    .eq('id', post.id)
    .eq('user_id', req.userId!);
  logger.info({ userId: req.userId, contentId: post.id }, 'blog-page: taken down');
  res.json({ success: true, data: null });
});
