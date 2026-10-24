/**
 * The dashboard's Recent rows say "View <title>". Each must open that item: they had been opening
 * the list it belongs to (/projects, /research, the Library filtered by type), so clicking a
 * project you had just made dropped you on the list of all of them.
 */
import { describe, it, expect } from 'vitest';
import { buildRecentFromPayload } from './useDashboardData';

const at = (m: number) => new Date(Date.UTC(2026, 9, 24, 12, m)).toISOString();

describe('Recent rows', () => {
  it('open the item itself, whatever its type', () => {
    const items = buildRecentFromPayload({
      target_user_id: 'u1',
      counts: {} as never,
      contentRows: [
        { id: 'c1', title: 'Chapter 1', content_type: 'chapter', status: 'draft', genre_slug: null, content_text: 'a b', chapter_number: 1, project_id: null, updated_at: at(3) },
        { id: 'n1', title: 'Issue 4', content_type: 'newsletter', status: 'draft', genre_slug: null, content_text: null, chapter_number: null, project_id: null, updated_at: at(2) },
      ],
      projectRows: [{ id: 'p1', title: 'The Ossuary', status: 'outlined', genre_slug: null, outline: null, updated_at: at(1) }],
      researchRows: [{ id: 'r1', topic: 'Accokeek Creek', status: 'complete', genre_slug: null, content: null, updated_at: at(0) }],
      projectMap: {},
    });
    expect(items.map((i) => [i.id, i.path])).toEqual([
      ['c1', '/content/c1'],
      ['n1', '/content/n1'],
      ['p1', '/projects/p1'],
      ['r1', '/research/r1'],
    ]);
  });
});
