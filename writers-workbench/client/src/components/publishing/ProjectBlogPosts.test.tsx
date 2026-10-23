/**
 * The project's blog posts, listed on the project.
 *
 * They were landing in the Content Library and nowhere else, which is the right home for everything
 * and therefore the wrong place to find the two posts about one book. What matters here is the
 * query: a list scoped to the wrong project, or one that shows deleted posts, is worse than no list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ProjectBlogPosts from './ProjectBlogPosts';
import { supabase } from '../../config/supabase';

// The query is scoped to the signed-in user, so without one it is disabled and the component shows
// its empty state — which would make every assertion below pass against nothing.
vi.mock('../../contexts/UserContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/UserContext')>()),
  useUser: () => ({ profile: { user_id: '+14105914612' }, isImpersonating: false }),
}));

const PROJECT = 'a1bfb2cf-2949-4d29-80d2-e8b785c6bdae';

const ROWS = [
  {
    id: 'post-1',
    title: "Digging up the truth: the research and true story behind Eric L. Beser's The Ossuary",
    content_text:
      '# Digging up the truth\n\nIn 1935, Alice and Henry Ferguson began digging up the dead on their Maryland farm. ' +
      'By the time they stopped, they had pulled the remains of more than a thousand people from the ground.',
    status: 'draft',
    created_at: '2026-10-23T11:41:55Z',
    metadata: {},
  },
  {
    id: 'post-2',
    title: 'Who Speaks for the Unnamed Dead? The History Behind The Ossuary',
    content_text: '# Who Speaks\n\nA thousand people in four boxes. Twenty-six names.',
    status: 'published',
    created_at: '2026-10-22T23:03:16Z',
    metadata: { pronoun_warning: '2 sentence(s) refer to you by a pronoun you have not set.' },
  },
];

/** Records what the query was filtered by, so the scoping can be asserted. */
const filters: Record<string, unknown> = {};

function stubQuery(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order'] as const) {
    chain[method] = vi.fn((a?: unknown, b?: unknown) => {
      if (method === 'eq') filters[String(a)] = b;
      if (method === 'is') filters[`is:${String(a)}`] = b;
      return chain;
    });
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
  vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
}

beforeEach(() => {
  for (const k of Object.keys(filters)) delete filters[k];
  vi.restoreAllMocks();
});

describe('listing a project’s blog posts', () => {
  it('shows every post written for this project', async () => {
    stubQuery(ROWS);
    renderWithProviders(<ProjectBlogPosts projectId={PROJECT} />);
    expect(await screen.findByText(/Digging up the truth/)).toBeInTheDocument();
    expect(screen.getByText(/Who Speaks for the Unnamed Dead/)).toBeInTheDocument();
  });

  it('scopes to this project, this content type, and the undeleted', async () => {
    stubQuery(ROWS);
    renderWithProviders(<ProjectBlogPosts projectId={PROJECT} />);
    await screen.findByText(/Digging up the truth/);
    expect(filters.project_id).toBe(PROJECT);
    expect(filters.content_type).toBe('blog_post');
    // A deleted post must not come back — the fabricated one was removed this way.
    expect(filters['is:deleted_at']).toBeNull();
  });

  it('previews the opening prose, not the markdown heading', async () => {
    stubQuery(ROWS);
    renderWithProviders(<ProjectBlogPosts projectId={PROJECT} />);
    expect(await screen.findByText(/In 1935, Alice and Henry Ferguson/)).toBeInTheDocument();
  });

  it('links each post to where it can be read', async () => {
    stubQuery(ROWS);
    renderWithProviders(<ProjectBlogPosts projectId={PROJECT} />);
    const link = await screen.findByText(/Digging up the truth/);
    expect(link.closest('a')).toHaveAttribute('href', '/content/post-1');
  });

  it('carries a pronoun warning with the post rather than leaving it in a log', async () => {
    stubQuery(ROWS);
    renderWithProviders(<ProjectBlogPosts projectId={PROJECT} />);
    expect(await screen.findByText(/refer to you by a pronoun you have not set/)).toBeInTheDocument();
  });

  it('says so plainly when there are none', async () => {
    stubQuery([]);
    renderWithProviders(<ProjectBlogPosts projectId={PROJECT} />);
    expect(await screen.findByText('No blog posts yet')).toBeInTheDocument();
  });
});
