/**
 * The Content Library list asks only for the columns it shows. It used `select('*')`, which pulled
 * every chapter's full text and metadata (14 MB for the DEV demo user's 471 rows) to render six short
 * columns; under concurrent load the page sat on "Loading..." long enough to fail the regression.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ContentLibrary, { LIBRARY_COLUMNS } from './ContentLibrary';

const selects: Record<string, string[]> = {};
const ROWS = [
  { id: 'c1', title: 'The Ossuary, Chapter 1', content_type: 'chapter', status: 'draft', genre_slug: 'ancient-history',
    project_id: 'p1', chapter_number: 1, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' },
];

vi.mock('../../contexts/UserContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/UserContext')>()),
  useUser: () => ({ profile: { user_id: 'u1' }, isImpersonating: false }),
}));

vi.mock('../../config/supabase', () => {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    c.select = (cols: string) => { (selects[table] ??= []).push(cols); return c; };
    for (const m of ['eq', 'is', 'in', 'order', 'limit']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: table === 'published_content_v2' ? ROWS : [], error: null }));
    return c;
  };
  return {
    supabase: {
      from: (table: string) => chain(table),
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      },
    },
  };
});

describe('Content Library', () => {
  it('lists content from the list columns only, never the full text', async () => {
    renderWithProviders(<ContentLibrary />);
    expect(await screen.findByText('The Ossuary, Chapter 1')).toBeInTheDocument();
    expect(selects.published_content_v2).toEqual([LIBRARY_COLUMNS]);
    expect(LIBRARY_COLUMNS).not.toMatch(/\*|content_text|content_html|metadata/);
  });
});
