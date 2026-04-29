/**
 * Multi-User Newsletters Sprint — schema-level smoke tests.
 *
 * Covers the zod schemas for the new editions CRUD + feeds CRUD + cron
 * callback routes. Heavier route tests (with the fake-Supabase pattern
 * from newsletter-templates.test.ts) are deferred until the bigger
 * tracker tests; here we verify the contract surface so a typo in a
 * schema field can't ship.
 */
import { describe, it, expect } from 'vitest';
import {
  CreateNewsletterEditionSchema,
  UpdateNewsletterEditionSchema,
  CreateNewsletterFeedSchema,
  UpdateNewsletterFeedSchema,
  FeedRunCallbackSchema,
  FeedsDueQuerySchema,
  FeedUrlTypeSchema,
} from '../schemas.js';

describe('CreateNewsletterEditionSchema', () => {
  it('accepts a complete edition', () => {
    const r = CreateNewsletterEditionSchema.safeParse({
      id: 'creator-news',
      display_name: 'Creator News',
      subheader: 'Things builders are reading',
      genre: 'creator-economy',
      newsletter_name: 'A Creators Weekly',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.primary_color).toBe('#14288c');
      expect(r.data.paper_color).toBe('#fbf8f2');
      expect(r.data.enabled).toBe(true);
    }
  });

  it('rejects non-slug ids', () => {
    const r = CreateNewsletterEditionSchema.safeParse({
      id: 'Creator News',
      display_name: 'x',
      subheader: 'x',
      genre: 'x',
      newsletter_name: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects malformed hex colors', () => {
    const r = CreateNewsletterEditionSchema.safeParse({
      id: 'creator-news',
      display_name: 'x',
      subheader: 'x',
      genre: 'x',
      newsletter_name: 'x',
      primary_color: 'red',
    });
    expect(r.success).toBe(false);
  });
});

describe('UpdateNewsletterEditionSchema', () => {
  it('requires at least one field', () => {
    expect(UpdateNewsletterEditionSchema.safeParse({}).success).toBe(false);
  });
  it('accepts a single-field update', () => {
    expect(UpdateNewsletterEditionSchema.safeParse({ display_name: 'rename' }).success).toBe(true);
  });
});

describe('Feed schemas', () => {
  it('CreateNewsletterFeedSchema defaults interval to 240', () => {
    const r = CreateNewsletterFeedSchema.safeParse({
      name: 'OpenAI Blog',
      url: 'https://example.com/feed.xml',
      url_type: 'rss',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.fetch_interval_minutes).toBe(240);
  });

  it('rejects intervals outside [5, 1440]', () => {
    expect(CreateNewsletterFeedSchema.safeParse({
      name: 'x', url: 'https://x', url_type: 'rss', fetch_interval_minutes: 1,
    }).success).toBe(false);
    expect(CreateNewsletterFeedSchema.safeParse({
      name: 'x', url: 'https://x', url_type: 'rss', fetch_interval_minutes: 9999,
    }).success).toBe(false);
  });

  it('rejects unknown url_type', () => {
    expect(FeedUrlTypeSchema.safeParse('twitter').success).toBe(false);
    expect(FeedUrlTypeSchema.safeParse('rss').success).toBe(true);
    expect(FeedUrlTypeSchema.safeParse('reddit').success).toBe(true);
  });

  it('rejects non-http URLs', () => {
    expect(CreateNewsletterFeedSchema.safeParse({
      name: 'x', url: 'ftp://example.com/feed', url_type: 'rss',
    }).success).toBe(false);
  });

  it('UpdateNewsletterFeedSchema requires at least one field', () => {
    expect(UpdateNewsletterFeedSchema.safeParse({}).success).toBe(false);
    expect(UpdateNewsletterFeedSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe('Cron callback schemas', () => {
  it('FeedRunCallbackSchema accepts an empty body', () => {
    expect(FeedRunCallbackSchema.safeParse({}).success).toBe(true);
  });

  it('FeedRunCallbackSchema accepts full payload', () => {
    const r = FeedRunCallbackSchema.safeParse({
      items_fetched: 12,
      items_uploaded: 7,
      items_skipped_existing: 5,
      error_message: null,
    });
    expect(r.success).toBe(true);
  });

  it('FeedRunCallbackSchema rejects negative counts', () => {
    expect(FeedRunCallbackSchema.safeParse({ items_uploaded: -1 }).success).toBe(false);
  });

  it('FeedsDueQuerySchema defaults limit to 100', () => {
    const r = FeedsDueQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(100);
  });

  it('FeedsDueQuerySchema clamps limit to 500', () => {
    expect(FeedsDueQuerySchema.safeParse({ limit: '600' }).success).toBe(false);
    expect(FeedsDueQuerySchema.safeParse({ limit: '50' }).success).toBe(true);
  });
});
