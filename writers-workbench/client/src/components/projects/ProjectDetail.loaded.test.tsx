/**
 * A project page that finishes loading.
 *
 * The other ProjectDetail tests render the not-found state, which never leaves the early returns,
 * so they could not see a hook declared below them. One was (`photoSubjects`, a useMemo): the
 * loading render ran N hooks, the loaded render N+1, and React replaced every project page with
 * error #310. This renders the transition that broke.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ProjectDetail from './ProjectDetail';

const PROJECT = {
  id: 'p1',
  user_id: 'u1',
  title: 'The Ossuary',
  genre_slug: 'ancient-history',
  status: 'active',
  outline: { premise: 'Four ossuaries on the Potomac in Maryland.', chapters: [] },
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useParams: () => ({ id: 'p1' }),
}));

vi.mock('../../contexts/UserContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/UserContext')>()),
  useUser: () => ({ profile: { user_id: 'u1' }, isImpersonating: false }),
}));

vi.mock('../../config/supabase', () => {
  const chain = (result: unknown): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'like', 'ilike', 'not', 'or', 'range']) {
      c[m] = () => chain(result);
    }
    c.maybeSingle = () => chain(result === 'project' ? 'project' : 'none');
    c.single = c.maybeSingle;
    const answer = { project: { data: PROJECT, error: null }, none: { data: null, error: null }, rows: { data: [], error: null, count: 0 } };
    c.then = (resolve: (v: unknown) => unknown) =>
      // Resolve on a later tick, so the first render is the loading one.
      new Promise((r) => setTimeout(r, 10)).then(() => resolve(answer[result as keyof typeof answer]));
    return c;
  };
  return {
    supabase: {
      from: (table: string) => chain(table === 'writing_projects_v2' ? 'project' : 'rows'),
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      },
    },
  };
});

describe('a project page', () => {
  it('renders after loading, instead of crashing on a hook below the loading return', async () => {
    renderWithProviders(<ProjectDetail />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'The Ossuary' })).toBeInTheDocument();
  });
});
