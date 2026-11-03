/**
 * The "My Projects" badge is the user's project count. It used to be the length of the sidebar's
 * list, which is capped at the 20 most recent, so a user with 37 projects saw "20" next to a
 * dashboard that said 37.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, within } from '../../test/test-utils';
import Sidebar from './Sidebar';

const ROWS = Array.from({ length: 20 }, (_, i) => ({
  id: `p${i}`, title: `Project ${i}`, status: 'outlined', updated_at: '2026-11-01T00:00:00Z',
}));

vi.mock('../../contexts/UserContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/UserContext')>()),
  useUser: () => ({ profile: { user_id: 'u1', role: 'user' }, isImpersonating: false, subscription: null }),
}));

vi.mock('../../config/supabase', () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: ROWS, error: null, count: 37 }));
    return c;
  };
  return {
    supabase: {
      from: () => chain(),
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      },
    },
  };
});

describe('Sidebar My Projects', () => {
  it('badges the real project count, while listing only the 20 most recent', async () => {
    renderWithProviders(<Sidebar open onToggle={() => {}} />);
    const header = await screen.findByRole('button', { name: /My Projects\s*37/ });
    expect(within(header).getByText('37')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Project \d+$/ })).toHaveLength(20);
  });
});
