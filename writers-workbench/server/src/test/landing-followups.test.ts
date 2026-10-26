/**
 * After the book page: a buy link once the book is on sale, and email to the people who reserved.
 *
 * Asserted: only an https buy link is accepted; with one set, the page's calls to action go to the
 * shop and the form becomes "keep me posted"; every email is one reader's own, addressed to them,
 * escaped, with their own unsubscribe link and the reason they are getting it; an unsubscribed
 * reader is skipped; a test goes to the author alone and is not recorded; and the unsubscribe link
 * works once, without a login, and says nothing about whether an address was on a list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { renderPreviewHtml, safeBuyUrl, type LandingCopy } from '../lib/landing-page.js';
import { renderMailing } from '../lib/landing-mail.js';

const COPY = {
  title: 'The Ossuary', author: 'Eric L Beser', hook: 'h', blurb: 'b', backCover: 'c', bio: '', facts: [], images: [],
  volumes: [], form: { heading: 'Reserve your copy', lede: 'Leave your name.', button: 'Reserve my copy', fields: ['First name', 'Email'] },
  seo: { title: '', description: '', keywords: [] },
} as unknown as LandingCopy;

describe('buy link', () => {
  it('accepts only a full https address', () => {
    expect(safeBuyUrl('https://www.amazon.com/dp/B0TEST')).toBe('https://www.amazon.com/dp/B0TEST');
    expect(safeBuyUrl('http://www.amazon.com/dp/B0TEST')).toBeNull();
    expect(safeBuyUrl('javascript:alert(1)')).toBeNull();
    expect(safeBuyUrl('https://user:pass@shop.example.com/')).toBeNull();
    expect(safeBuyUrl('amazon.com')).toBeNull();
  });

  it('sends every call to action to the shop, and turns the form into "keep me posted"', () => {
    const html = renderPreviewHtml(COPY, undefined, { formAction: '/books/x/reserve', canonicalUrl: 'https://w/books/x', buy: { url: 'https://shop.example.com/ossuary', label: 'Buy the book' } });
    expect(html).toContain('<a href="https://shop.example.com/ossuary" rel="noopener">Buy the book</a>');
    expect(html).not.toContain('href="#reserve"');
    expect(html).toContain('Keep me posted');
    expect(html).not.toContain('Reserve my copy');
  });

  it('without one the page is the pre-order page it was', () => {
    const html = renderPreviewHtml(COPY, undefined, { formAction: '/books/x/reserve', canonicalUrl: 'https://w/books/x' });
    expect(html).toContain('href="#reserve"');
    expect(html).toContain('Reserve my copy');
  });
});

describe('the email', () => {
  const m = renderMailing({
    title: 'The Ossuary', author: 'Eric L Beser', subject: 's', firstName: 'Ada',
    body: 'The book is out.\n\nIt <b>is</b> here.', buy: { url: 'https://shop.example.com/o', label: 'Buy the book' },
    pageUrl: 'https://w/books/the-ossuary', unsubscribeUrl: 'https://w/books/the-ossuary/unsubscribe?t=abc',
  });

  it('is addressed to the reader, escapes what the author typed, and carries the buy link', () => {
    expect(m.html).toContain('<p>Hi Ada,</p>');
    expect(m.html).toContain('It &lt;b&gt;is&lt;/b&gt; here.');
    expect(m.html).toContain('href="https://shop.example.com/o"');
    expect(m.text).toContain('Buy the book: https://shop.example.com/o');
  });

  it('says why they are getting it, and how to stop it', () => {
    for (const part of [m.html, m.text]) {
      expect(part).toContain('You are getting this because you reserved a copy of The Ossuary at https://w/books/the-ossuary.');
      expect(part).toContain('https://w/books/the-ossuary/unsubscribe?t=abc');
    }
  });
});

// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const sent: { to: string; subject: string; html: string; replyTo?: string }[] = [];
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => { req.userId = 'u1'; next(); },
  requireTierFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/email.js', () => ({
  sendEmail: async (m: { to: string; subject: string; html: string; replyTo?: string }) => { sent.push(m); return { ok: !m.to.startsWith('bounce'), mode: 'sent' }; },
}));
vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: () => q, range: () => q, like: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      insert: (r: Row) => { (db[table] ??= []).push({ ...r }); return Promise.resolve({ error: null }); },
      update: (p: Row) => ((patch = p), q),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch) { for (const r of rows()) Object.assign(r, patch); return resolve({ data: rows(), error: null }); }
        resolve({ data: rows(), error: null, count: rows().length });
      },
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from }) };
});

const T1 = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  sent.length = 0;
  process.env.PUBLIC_APP_URL = 'https://writersworkbench-develop.up.railway.app';
  db.writing_projects_v2 = [{
    id: 'p1', user_id: 'u1', title: 'The Ossuary', genre_slug: null, deleted_at: null,
    outline: { _landing_page_public: { slug: 'the-ossuary', published_at: 'x' } },
  }];
  db.author_profiles_v2 = [{ user_id: 'u1', pen_name: 'Eric L Beser' }];
  db.users_v2 = [{ user_id: 'u1', email: 'author@example.com', display_name: 'Eric' }];
  db.landing_page_mailings_v2 = [];
  db.landing_page_reservations_v2 = [
    { id: 'r1', user_id: 'u1', project_id: 'p1', first_name: 'Ada', email: 'ada@example.com', unsubscribe_token: T1, unsubscribed_at: null },
    { id: 'r2', user_id: 'u1', project_id: 'p1', first_name: 'Bo', email: 'bo@example.com', unsubscribe_token: '22222222-2222-4222-8222-222222222222', unsubscribed_at: '2026-10-01' },
    { id: 'r3', user_id: 'u1', project_id: 'p1', first_name: '', email: 'bounce@example.com', unsubscribe_token: '33333333-3333-4333-8333-333333333333', unsubscribed_at: null },
  ];
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { landingPageRouter } = await import('../routes/landing-page.js');
  const { bookPagesRouter } = await import('../routes/book-pages.js');
  const app = express();
  app.use('/books', bookPagesRouter);
  app.use(express.json());
  app.use('/api/landing-page', landingPageRouter);
  const server = app.listen(0);
  try { return await fn(`http://localhost:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (base: string, method: string, path: string, body?: unknown): Promise<any> =>
  fetch(`${base}/api/landing-page/project/p1${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

describe('routes', () => {
  it('stores a buy link, refuses a bad one, and clears it', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'PUT', '/buy-link', { url: 'http://x.com' })).error.code).toBe('BAD_URL');
      const ok = await call(base, 'PUT', '/buy-link', { url: 'https://shop.example.com/o', label: 'Buy it' });
      expect(ok.data.buy).toEqual({ url: 'https://shop.example.com/o', label: 'Buy it' });
      await call(base, 'PUT', '/buy-link', { url: null });
      expect((db.writing_projects_v2[0].outline as Row)._landing_page_buy).toBeUndefined();
    });
  });

  it('writes to everyone still on the list, one email each, and records the mailing', async () => {
    await withServer(async (base) => {
      const j = await call(base, 'POST', '/mailings', { subject: 'It is out', body: 'The book is out.' });
      expect(j.data).toMatchObject({ recipients: 2, sent: 1, failed: 1 });
      expect(sent.map((m) => m.to)).toEqual(['ada@example.com', 'bounce@example.com']);
      expect(sent[0].html).toContain('Hi Ada,');
      expect(sent[0].html).toContain(`https://writersworkbench-develop.up.railway.app/books/the-ossuary/unsubscribe?t=${T1}`);
      expect(sent[0].replyTo).toBe('author@example.com');
      expect(db.landing_page_reservations_v2[0].last_emailed_at).toBeTruthy();
      expect(db.landing_page_reservations_v2[2].last_emailed_at).toBeUndefined();
      expect(db.landing_page_mailings_v2[0]).toMatchObject({ subject: 'It is out', recipients: 2, sent: 1, failed: 1 });
    });
  });

  it('a test goes to the author alone and is not recorded', async () => {
    await withServer(async (base) => {
      const j = await call(base, 'POST', '/mailings', { subject: 'It is out', body: 'b', test: true });
      expect(j.data).toMatchObject({ test: true, to: 'author@example.com', ok: true });
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe('[Test] It is out');
      expect(db.landing_page_mailings_v2).toHaveLength(0);
    });
  });

  it('refuses to send before the page is published', async () => {
    (db.writing_projects_v2[0].outline as Row)._landing_page_public = undefined;
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/mailings', { subject: 's', body: 'b' })).error.code).toBe('NOT_PUBLISHED');
    });
  });

  it('unsubscribes with one click, and answers the same for an unknown token', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/books/the-ossuary/unsubscribe?t=${T1}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('You will not get these emails again');
      expect(db.landing_page_reservations_v2[0].unsubscribed_at).toBeTruthy();
      const unknown = await fetch(`${base}/books/the-ossuary/unsubscribe?t=99999999-9999-4999-8999-999999999999`);
      expect(await unknown.text()).toContain('You will not get these emails again');
    });
  });
});
