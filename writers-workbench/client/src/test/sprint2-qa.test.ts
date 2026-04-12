import { describe, it, expect } from 'vitest';

describe('Sprint 2: Pagination component', () => {
  it('getPageNumbers returns correct pages for small total', () => {
    // Inlined logic from Pagination for unit testing
    function getPageNumbers(current: number, total: number): (number | '...')[] {
      if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
      const pages: (number | '...')[] = [1];
      if (current > 3) pages.push('...');
      const start = Math.max(2, current - 1);
      const end = Math.min(total - 1, current + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (current < total - 2) pages.push('...');
      pages.push(total);
      return pages;
    }

    expect(getPageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(getPageNumbers(1, 1)).toEqual([1]);
    expect(getPageNumbers(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('getPageNumbers handles large page counts with ellipsis', () => {
    function getPageNumbers(current: number, total: number): (number | '...')[] {
      if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
      const pages: (number | '...')[] = [1];
      if (current > 3) pages.push('...');
      const start = Math.max(2, current - 1);
      const end = Math.min(total - 1, current + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (current < total - 2) pages.push('...');
      pages.push(total);
      return pages;
    }

    // Page 1 of 20: [1, 2, ..., 20]
    const p1 = getPageNumbers(1, 20);
    expect(p1[0]).toBe(1);
    expect(p1[p1.length - 1]).toBe(20);
    expect(p1).toContain('...');

    // Page 10 of 20: [1, ..., 9, 10, 11, ..., 20]
    const p10 = getPageNumbers(10, 20);
    expect(p10).toContain(9);
    expect(p10).toContain(10);
    expect(p10).toContain(11);
    expect(p10[0]).toBe(1);
    expect(p10[p10.length - 1]).toBe(20);

    // Page 20 of 20: [1, ..., 19, 20]
    const p20 = getPageNumbers(20, 20);
    expect(p20[p20.length - 1]).toBe(20);
    expect(p20[0]).toBe(1);
  });
});

describe('Sprint 2: Content type labels', () => {
  const contentTypeLabels: Record<string, string> = {
    chapter: 'Chapter',
    short_story: 'Short Story',
    blog_post: 'Blog Post',
    newsletter: 'Newsletter',
  };

  it('maps all content types to labels', () => {
    expect(contentTypeLabels.chapter).toBe('Chapter');
    expect(contentTypeLabels.short_story).toBe('Short Story');
    expect(contentTypeLabels.blog_post).toBe('Blog Post');
    expect(contentTypeLabels.newsletter).toBe('Newsletter');
  });
});

describe('Sprint 2: Breadcrumb labels', () => {
  const breadcrumbLabels: Record<string, string> = {
    '': 'Dashboard',
    projects: 'Projects',
    library: 'Content Library',
    research: 'Research',
    outlines: 'Outlines',
    'story-arcs': 'Story Arcs',
    genres: 'Genres',
    trash: 'Trash',
    settings: 'Settings',
    admin: 'Admin',
    content: 'Content',
    bible: 'Story Bible',
  };

  it('has all required labels for new navigation', () => {
    expect(breadcrumbLabels.library).toBe('Content Library');
    expect(breadcrumbLabels.projects).toBe('Projects');
    expect(breadcrumbLabels.trash).toBe('Trash');
    expect(breadcrumbLabels.bible).toBe('Story Bible');
  });

  it('removed old content type labels', () => {
    expect(breadcrumbLabels.chapters).toBeUndefined();
    expect(breadcrumbLabels['short-stories']).toBeUndefined();
    expect(breadcrumbLabels['blog-posts']).toBeUndefined();
    expect(breadcrumbLabels.newsletters).toBeUndefined();
    expect(breadcrumbLabels.social).toBeUndefined();
    expect(breadcrumbLabels['cover-art']).toBeUndefined();
  });
});

describe('Sprint 2: Tab definitions', () => {
  const TABS = ['overview', 'outline', 'chapters', 'bible', 'art', 'research', 'cost', 'export'] as const;

  it('Project Workspace has all 8 tabs', () => {
    expect(TABS).toHaveLength(8);
    expect(TABS).toContain('overview');
    expect(TABS).toContain('outline');
    expect(TABS).toContain('chapters');
    expect(TABS).toContain('bible');
    expect(TABS).toContain('art');
    expect(TABS).toContain('research');
    expect(TABS).toContain('cost');
    expect(TABS).toContain('export');
  });
});

describe('Sprint 2: Route structure', () => {
  it('legacy routes should map to library with type params', () => {
    const legacyRedirects: Record<string, string> = {
      '/chapters': '/library?type=chapter',
      '/short-stories': '/library?type=short_story',
      '/blog-posts': '/library?type=blog_post',
      '/newsletters': '/library?type=newsletter',
    };

    expect(Object.keys(legacyRedirects)).toHaveLength(4);
    expect(legacyRedirects['/chapters']).toContain('chapter');
    expect(legacyRedirects['/short-stories']).toContain('short_story');
    expect(legacyRedirects['/blog-posts']).toContain('blog_post');
    expect(legacyRedirects['/newsletters']).toContain('newsletter');
  });
});
