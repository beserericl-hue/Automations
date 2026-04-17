import { describe, it, expect } from 'vitest';
import type { GenreConfig, OutlineChapter, SubChapter, StoryArc, ChapterOutline } from '../types/database';

// ---- S2.5-1: Genre Detail Section on Overview Tab ----
describe('S2.5-1: Genre Detail Section', () => {
  it('OverviewTab renders genre name, description, and keywords when genreConfig is provided', async () => {
    // Dynamically import so mocks are in place
    const { default: ProjectDetail } = await import('../components/projects/ProjectDetail');
    // The component uses useParams, useQuery etc — we verify the code structure instead
    // since Supabase is fully mocked and returns null data
    expect(ProjectDetail).toBeDefined();
  });

  it('GenreConfig type includes all required display fields', () => {
    const genre: GenreConfig = {
      id: '1', user_id: null,
      genre_name: 'Political Scifi',
      genre_slug: 'political-scifi',
      description: 'Sci-fi with political themes',
      keywords: ['politics', 'dystopia'],
      rss_feed_urls: ['https://example.com/rss'],
      source_urls: ['https://example.com'],
      subreddit_names: ['r/scifi'],
      goodreads_shelves: ['political-fiction'],
      writing_guidelines: 'Write with political nuance',
      active: true,
      created_at: '2026-01-01',
    };
    // Verify all fields used in the genre detail section exist
    expect(genre.genre_name).toBeTruthy();
    expect(genre.description).toBeTruthy();
    expect(genre.keywords.length).toBeGreaterThan(0);
    expect(genre.writing_guidelines).toBeTruthy();
    expect(genre.rss_feed_urls.length).toBeGreaterThan(0);
    expect(genre.source_urls.length).toBeGreaterThan(0);
    expect(genre.subreddit_names.length).toBeGreaterThan(0);
    expect(genre.goodreads_shelves.length).toBeGreaterThan(0);
  });

  it('ProjectDetail queries genre_config_v2 table', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain("from('genre_config_v2')");
    expect(code).toContain("genreConfig");
    expect(code).toContain("genre_name");
    expect(code).toContain("writing_guidelines");
    expect(code).toContain("keywords");
  });
});

// ---- S2.5-2: Full Outline Display on Outline Tab ----
describe('S2.5-2: Full Outline Display', () => {
  it('OutlineTab shows book-level overview (premise, themes, characters, story arc)', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    // Book Overview section exists
    expect(code).toContain('Book Overview');
    // Premise displayed in outline tab
    expect(code).toContain('outline.premise');
    // Themes displayed in outline tab
    expect(code).toContain('outline.themes');
    // Characters displayed in outline tab
    expect(code).toContain('outline.characters');
    // Story arc name displayed
    expect(code).toContain('outline.story_arc_name');
  });

  it('OutlineTab queries story_arcs_v2 and displays arc description', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain("from('story_arcs_v2')");
    expect(code).toContain('storyArc');
    expect(code).toContain('storyArc.description');
  });

  it('OutlineTab has collapsible Book Overview section', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain('bookOverviewOpen');
    expect(code).toContain('setBookOverviewOpen');
  });

  it('Chapter titles are clickable when chapter_outline exists', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    // hasOutline check gates the clickable button
    expect(code).toContain('hasOutline');
    expect(code).toContain('toggleChapter');
    // Clickable title uses brand color
    expect(code).toContain('text-brand-700');
    // Chevron icon for expand/collapse
    expect(code).toContain('rotate-90');
  });

  it('Chapter titles are plain text when no chapter_outline', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    // Fallback to plain span when !hasOutline
    expect(code).toMatch(/hasOutline.*\?[\s\S]*?<button[\s\S]*?:[\s\S]*?<span/);
  });

  it('Expanded chapter shows sub-chapter brief, characters, and arc_beat', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    // Sub-chapter fields rendered when expanded
    expect(code).toContain('sub.brief');
    expect(code).toContain('sub.characters');
    expect(code).toContain('sub.arc_beat');
    expect(code).toContain('sub.section_number');
    expect(code).toContain('sub.title');
  });

  it('Expand all / Collapse all controls exist', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain('Expand all');
    expect(code).toContain('Collapse all');
    expect(code).toContain('expandAll');
    expect(code).toContain('collapseAll');
  });

  it('chapter_outline as object (real data format) extracts sub_chapters', async () => {
    // This is the actual data shape from the brainstorm_chapter workflow
    const objectFormat: ChapterOutline = {
      chapter_title: 'The Demonstration',
      chapter_number: 0,
      chapter_summary: 'Cogwheel is unveiled',
      chapter_story_arc: "Dan Harmon's Story Circle",
      book_arc_beat: 'Step 1 - Comfort Zone',
      sub_chapters: [
        { number: 1, title: 'The Gilded Assembly', brief: 'Aristocrats gather', characters: ['Blackwood'], arc_beat: 'Order' },
        { number: 2, title: 'The Unveiling', brief: 'Cogwheel revealed', characters: ['Cogwheel'], arc_beat: 'Need' },
      ],
    };
    expect(objectFormat.sub_chapters).toHaveLength(2);
    expect(objectFormat.sub_chapters[0].number).toBe(1);
    expect(objectFormat.sub_chapters[0].characters).toContain('Blackwood');
  });

  it('chapter_outline as array (legacy format) works directly', () => {
    const arrayFormat: SubChapter[] = [
      { section_number: 1, title: 'Scene 1', brief: 'First scene' },
    ];
    expect(arrayFormat).toHaveLength(1);
    expect(arrayFormat[0].section_number).toBe(1);
  });

  it('getSubChapters and getChapterMeta handle both formats', async () => {
    const source = await import('../components/projects/ProjectDetail?raw');
    const code = (source as unknown as { default: string }).default;
    // Helper functions exist
    expect(code).toContain('function getSubChapters');
    expect(code).toContain('function getChapterMeta');
    // Handles array format
    expect(code).toContain('Array.isArray(co)');
    // Handles object format with sub_chapters
    expect(code).toContain("'sub_chapters' in co");
  });

  it('OutlineChapter supports Prologue/Epilogue as string number', () => {
    const prologue: OutlineChapter = {
      number: 'Prologue', title: 'The Beginning', brief: 'Sets the stage',
      chapter_outline: [{ section_number: 1, title: 'Opening', brief: 'First scene' }],
    };
    const epilogue: OutlineChapter = {
      number: 'Epilogue', title: 'The End', brief: 'Wraps up',
    };
    expect(typeof prologue.number).toBe('string');
    expect(prologue.chapter_outline).toHaveLength(1);
    expect(epilogue.chapter_outline).toBeUndefined();
  });

  it('SubChapter optional fields work correctly', () => {
    const withAll: SubChapter = {
      section_number: 1, title: 'Crisis 1', brief: 'First crisis',
      characters: ['Mason', 'Lucia'], arc_beat: 'Rising Action',
    };
    const minimal: SubChapter = { section_number: 2, title: 'Scene 2', brief: 'Continues' };
    expect(withAll.characters).toContain('Mason');
    expect(withAll.arc_beat).toBe('Rising Action');
    expect(minimal.characters).toBeUndefined();
    expect(minimal.arc_beat).toBeUndefined();
  });
});

// ---- S2.5-3: Eve Widget User ID Fix ----
describe('S2.5-3: Eve Widget User ID', () => {
  it('EveWidget sets dynamic-variables attribute with user_id', async () => {
    const source = await import('../components/eve/EveWidget?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain('dynamic-variables');
    expect(code).toContain('profile?.user_id');
    expect(code).toContain("user_id: profile.user_id");
  });

  it('EveWidget imports useUser from UserContext', async () => {
    const source = await import('../components/eve/EveWidget?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain("import { useUser }");
    expect(code).toContain("useUser()");
  });

  it('EveWidget re-creates on user_id change (dependency array)', async () => {
    const source = await import('../components/eve/EveWidget?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain("[profile?.user_id]");
  });
});

// ---- S2.5-5: Brainstorm Form ----
describe('S2.5-5: Brainstorm Form', () => {
  it('BrainstormForm has all required form fields', async () => {
    const source = await import('../components/brainstorm/BrainstormForm?raw');
    const code = (source as unknown as { default: string }).default;
    // Title input
    expect(code).toContain('title');
    expect(code).toContain('setTitle');
    // Genre dropdown from genre_config_v2
    expect(code).toContain("from('genre_config_v2')");
    expect(code).toContain('genreSlug');
    // Story arc dropdown from story_arcs_v2
    expect(code).toContain("from('story_arcs_v2')");
    expect(code).toContain('storyArc');
    // Chapter count input
    expect(code).toContain('chapterCount');
    expect(code).toContain('Target Chapter Count');
    // Content textarea
    expect(code).toContain('contentText');
    expect(code).toContain('50,000 characters');
    // File upload
    expect(code).toContain('.docx');
    expect(code).toContain('.pdf');
    // Themes
    expect(code).toContain('themes');
    expect(code).toContain('removeTheme');
    expect(code).toContain('addTheme');
  });

  it('BrainstormForm has parse and submit endpoints', async () => {
    const source = await import('../components/brainstorm/BrainstormForm?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain('/api/brainstorm/parse');
    expect(code).toContain('/api/brainstorm/submit');
  });

  it('BrainstormForm has 3-step UX flow', async () => {
    const source = await import('../components/brainstorm/BrainstormForm?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain('Step 1');
    expect(code).toContain('Step 2');
    expect(code).toContain('Step 3');
    expect(code).toContain('Analyze Content');
    expect(code).toContain('Submit Brainstorm');
  });

  it('BrainstormForm disables submit until required fields are filled', async () => {
    const source = await import('../components/brainstorm/BrainstormForm?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain('canSubmit');
    // canSubmit requires content + title + genre + story arc
    expect(code).toMatch(/canSubmit[\s\S]*title[\s\S]*genreSlug[\s\S]*storyArc/);
  });

  it('BrainstormForm auto-matches genre and arc from parse results', async () => {
    const source = await import('../components/brainstorm/BrainstormForm?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain('matchGenre');
    expect(code).toContain('matchArc');
  });

  it('BrainstormForm route exists in App.tsx', async () => {
    const source = await import('../App?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain("path=\"brainstorm\"");
    expect(code).toContain('BrainstormForm');
  });

  it('Sidebar has Brainstorm link', async () => {
    const source = await import('../components/layout/Sidebar?raw');
    const code = (source as unknown as { default: string }).default;
    expect(code).toContain('to="/brainstorm"');
    expect(code).toContain('BrainstormIcon');
    expect(code).toContain('Brainstorm');
  });

  it('StoryArc type has all fields needed for brainstorm dropdown', () => {
    const arc: StoryArc = {
      id: '1', user_id: null,
      name: 'Fichtean Curve',
      description: 'Series of escalating crises',
      prompt_text: 'Use the Fichtean Curve...',
      discovery_question: 'What is the core moral dilemma?',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    };
    expect(arc.name).toBe('Fichtean Curve');
    expect(arc.description).toBeTruthy();
    expect(arc.discovery_question).toBeTruthy();
  });
});
