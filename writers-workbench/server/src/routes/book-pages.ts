/**
 * A book's public landing page: /books/<slug>.
 *
 * No login. This is the page a reader arrives at from an ad or a post, so it is server-rendered
 * HTML with a plain form, no app bundle and no script, and it works with JavaScript turned off.
 * The copy is the project's saved landing-page script (landing-page.ts), rendered by the same
 * function as the preview the author approved, so what they reviewed is what goes out.
 *
 * The form posts here, the reservation is stored (migration 035), and the reader is sent back to
 * the page with a thank-you in place of a separate confirmation screen. The same address twice is
 * one reservation.
 *
 * Mounted before CORS in index.ts: a form submission carries an Origin header, and this page must
 * accept one from wherever it is served, not only from the app's own whitelist.
 */

import express, { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';
import { renderPreviewHtml, type LandingCopy, type SectionPlan } from '../lib/landing-page.js';

export const bookPagesRouter = Router();

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}\.[^\s@<>]{2,}$/;

/** The reader's own address, not the proxy's: Railway puts every request behind one. */
function clientIp(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
}

const reserveLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  validate: { xForwardedForHeader: false },
  handler: (req, res) => {
    res.redirect(303, `/books/${req.params.slug}?reserved=wait#reserve`);
  },
});

interface PageRow {
  id: string;
  user_id: string;
  title: string;
  landing: { copy: LandingCopy; plan: SectionPlan[] } | null;
}

async function findPage(slug: string): Promise<PageRow | null> {
  if (!SLUG.test(slug) || slug.length > 80) return null;
  const { data, error } = await getSupabaseAdmin()
    .from('writing_projects_v2')
    .select('id, user_id, title, landing:outline->_landing_page')
    .eq('outline->_landing_page_public->>slug', slug)
    .is('deleted_at', null)
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as unknown as PageRow | undefined;
  return row?.landing?.copy ? row : null;
}

function selfUrl(req: Request, slug: string): string {
  const host = req.get('x-forwarded-host') ?? req.get('host') ?? '';
  const proto = req.get('x-forwarded-proto')?.split(',')[0] ?? req.protocol;
  return `${proto}://${host}/books/${slug}`;
}

function notFound(res: Response): void {
  res
    .status(404)
    .type('html')
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Page not found</title><style>body{font:18px/1.6 Georgia,serif;max-width:560px;margin:80px auto;padding:0 16px;color:#2b211b;background:#f6f0e6}</style>' +
        '</head><body><h1>This page is not available</h1><p>The book page you were looking for has not been published, or has been taken down.</p></body></html>',
    );
}

const NOTICES: Record<string, (title: string) => string> = {
  '1': (title) => `Thank you. You are on the list, and we will write to you when ${title} is released.`,
  invalid: () => 'That email address does not look right. Please check it and try again.',
  wait: () => 'Too many attempts from this connection. Please wait a few minutes and try again.',
  error: () => 'Something went wrong saving your reservation. Please try again.',
};

bookPagesRouter.get('/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  try {
    const page = await findPage(slug);
    if (!page || !page.landing) return notFound(res);
    const notice = NOTICES[String(req.query.reserved ?? '')]?.(page.title);
    const html = renderPreviewHtml(page.landing.copy, page.landing.plan, {
      formAction: `/books/${slug}/reserve`,
      canonicalUrl: selfUrl(req, slug),
      notice,
    });
    // Regenerating the script changes the page; a stale copy must not outlive that.
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (err) {
    logger.error({ err, slug }, 'book-page: render failed');
    res.status(500).type('text').send('This page could not be loaded. Please try again shortly.');
  }
});

bookPagesRouter.post(
  '/:slug/reserve',
  reserveLimiter,
  express.urlencoded({ extended: false, limit: '10kb' }),
  async (req: Request, res: Response) => {
    const slug = String(req.params.slug);
    const back = (state: string) => res.redirect(303, `/books/${slug}?reserved=${state}#reserve`);
    const body = (req.body ?? {}) as Record<string, unknown>;

    // A person never sees the "website" field. Something that filled it in is answered as if it
    // succeeded, so it learns nothing, and nothing is stored.
    if (String(body.website ?? '').trim()) return back('1');

    const email = String(body.email ?? '').trim();
    // eslint-disable-next-line no-control-regex
    const firstName = String(body.first_name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
    if (email.length > 320 || !EMAIL.test(email)) return back('invalid');

    try {
      const page = await findPage(slug);
      if (!page) return notFound(res);
      const { error } = await getSupabaseAdmin()
        .from('landing_page_reservations_v2')
        .upsert(
          { project_id: page.id, user_id: page.user_id, first_name: firstName, email, slug },
          { onConflict: 'project_id,email_normalized', ignoreDuplicates: true },
        );
      if (error) throw new Error(error.message);
      logger.info({ projectId: page.id, slug }, 'book-page: reservation');
      back('1');
    } catch (err) {
      logger.error({ err, slug }, 'book-page: reservation failed');
      back('error');
    }
  },
);
