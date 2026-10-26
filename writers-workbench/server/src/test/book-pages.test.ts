/**
 * The public book page, over HTTP, as a stranger meets it: no login, a form that works without
 * script, one reservation per address, and nothing stored from a bot or a bad address.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const state = {
  reservations: [] as Record<string, string>[],
  published: true,
};

const COPY = {
  title: 'The Ossuary',
  author: 'Eric L Beser',
  hook: 'A thousand people in four boxes. Twenty-six names.',
  blurb: 'Who speaks for the dead?',
  backCover: 'Four ossuaries. No names.',
  volumes: [{ index: 1, hook: 'A thousand people in four boxes. Twenty-six names.' }],
  bio: 'Eric Beser lives in Owings Mills, Maryland.',
  facts: [],
  images: [{ role: 'cover', url: 'https://x.supabase.co/cover.png', alt: 'Cover' }],
  form: { heading: 'Reserve your copy', lede: 'Leave your name and email.', button: 'Reserve my copy', fields: ['First name', 'Email'] },
  seo: { title: 'The Ossuary: a novel by Eric L Beser', description: 'A thousand people.', keywords: [] },
};

vi.mock('../services/supabase-admin.js', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        is: () => q,
        eq: (col: string, v: unknown) => ((filters[col] = v), q),
        limit: async () => {
          if (table !== 'writing_projects_v2') return { data: [], error: null };
          const hit = state.published && filters['outline->_landing_page_public->>slug'] === 'the-ossuary';
          return {
            data: hit ? [{ id: 'p1', user_id: '+14105914612', title: 'The Ossuary', landing: { copy: COPY, plan: [{ kind: 'hero', cta: true }, { kind: 'offer', cta: false }] } }] : [],
            error: null,
          };
        },
        upsert: async (row: Record<string, string>) => {
          const dup = state.reservations.some(
            (r) => r.project_id === row.project_id && r.email.trim().toLowerCase() === row.email.trim().toLowerCase(),
          );
          if (!dup) state.reservations.push(row);
          return { error: null };
        },
      };
      return q;
    },
  }),
}));

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { bookPagesRouter } = await import('../routes/book-pages.js');
  const app = express();
  // As in index.ts: Railway's edge and router are trusted, so req.ip is the client.
  app.set('trust proxy', 2);
  app.use('/books', bookPagesRouter);
  const server = app.listen(0);
  try {
    return await fn(`http://localhost:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

function reserve(base: string, fields: Record<string, string>, ip = '203.0.113.1') {
  return fetch(`${base}/books/the-ossuary/reserve`, {
    method: 'POST',
    redirect: 'manual',
    // The client as Railway's edge reports it, followed by the edge itself.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': `${ip}, 152.233.30.104` },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => {
  state.reservations = [];
  state.published = true;
});

describe('GET /books/:slug', () => {
  it('serves the page to anyone, with a form that posts back to it', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/books/the-ossuary`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      const html = await r.text();
      expect(html).toContain('A thousand people in four boxes. Twenty-six names.');
      expect(html).toContain('<form method="post" action="/books/the-ossuary/reserve">');
      expect(html).toContain('<title>The Ossuary: a novel by Eric L Beser</title>');
    });
  });

  it('is a 404 when the page is not published, or the address is not a slug', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/books/some-other-book`)).status).toBe(404);
      expect((await fetch(`${base}/books/The%20Ossuary`)).status).toBe(404);
      state.published = false;
      expect((await fetch(`${base}/books/the-ossuary`)).status).toBe(404);
    });
  });

  it('thanks the reader after a reservation', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(`${base}/books/the-ossuary?reserved=1`)).text();
      expect(html).toContain('Thank you. You are on the list, and we will write to you when The Ossuary is released.');
    });
  });
});

describe('POST /books/:slug/reserve', () => {
  it('stores the reservation against the book and its author, then returns to the page', async () => {
    await withServer(async (base) => {
      const r = await reserve(base, { first_name: 'Ada', email: 'ada@example.com' });
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe('/books/the-ossuary?reserved=1#reserve');
      expect(state.reservations).toEqual([
        { project_id: 'p1', user_id: '+14105914612', first_name: 'Ada', email: 'ada@example.com', slug: 'the-ossuary' },
      ]);
    });
  });

  it('keeps one reservation per address, whatever its case', async () => {
    await withServer(async (base) => {
      await reserve(base, { email: 'ada@example.com' });
      await reserve(base, { email: ' ADA@Example.com ' });
      expect(state.reservations).toHaveLength(1);
    });
  });

  it('refuses a bad address and stores nothing', async () => {
    await withServer(async (base) => {
      for (const email of ['', 'not-an-email', 'a@b', '<script>@x.com']) {
        const r = await reserve(base, { email });
        expect(r.headers.get('location'), email).toBe('/books/the-ossuary?reserved=invalid#reserve');
      }
      expect(state.reservations).toEqual([]);
    });
  });

  it('answers a bot that fills the hidden field as if it worked, and stores nothing', async () => {
    await withServer(async (base) => {
      const r = await reserve(base, { email: 'bot@example.com', website: 'http://spam' });
      expect(r.headers.get('location')).toBe('/books/the-ossuary?reserved=1#reserve');
      expect(state.reservations).toEqual([]);
    });
  });

  it('slows one connection down without blocking another', async () => {
    await withServer(async (base) => {
      for (let i = 0; i < 10; i++) await reserve(base, { email: `r${i}@example.com` }, '198.51.100.7');
      const blocked = await reserve(base, { email: 'r10@example.com' }, '198.51.100.7');
      expect(blocked.headers.get('location')).toBe('/books/the-ossuary?reserved=wait#reserve');
      const other = await reserve(base, { email: 'someone@example.com' }, '198.51.100.8');
      expect(other.headers.get('location')).toBe('/books/the-ossuary?reserved=1#reserve');
      expect(state.reservations).toHaveLength(11);
    });
  });
});
