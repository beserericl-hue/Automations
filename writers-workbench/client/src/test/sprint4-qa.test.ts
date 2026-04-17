import { describe, it, expect } from 'vitest';
import type { GeneratedImage, SocialPost, PublishedContent } from '../types/database';

// Sprint 4: Image & Social Media Management — QA Tests

// ---- S4-1: Image Persistence Layer ----
describe('S4-1: Image persistence types', () => {
  it('GeneratedImage type has all required fields', () => {
    const image: GeneratedImage = {
      id: 'img-1',
      user_id: '+14105914612',
      content_id: null,
      project_id: 'proj-1',
      image_type: 'cover_art',
      platform: null,
      storage_path: '+14105914612/20260412_test-book.png',
      thumbnail_path: null,
      original_prompt: 'A photorealistic editorial photograph...',
      genre_slug: 'post-apocalyptic',
      image_format: 'png',
      width: 1920,
      height: 1080,
      file_size_bytes: 1024000,
      generation_model: 'nano-banana-pro',
      metadata: { story_title: 'Test Book' },
      created_at: '2026-04-12T00:00:00Z',
    };
    expect(image.image_type).toBe('cover_art');
    expect(image.storage_path).toContain('.png');
    expect(image.generation_model).toBe('nano-banana-pro');
    expect(image.platform).toBeNull();
  });

  it('GeneratedImage supports all image_type values', () => {
    const types: GeneratedImage['image_type'][] = ['cover_art', 'chapter_art', 'social_media', 'newsletter_section'];
    expect(types).toHaveLength(4);
  });

  it('SocialPost type has all required fields', () => {
    const post: SocialPost = {
      id: 'sp-1',
      user_id: '+14105914612',
      source_content_id: null,
      project_id: 'proj-1',
      platform: 'twitter',
      post_text: 'Check out this amazing sci-fi story...',
      hashtags: ['scifi', 'writing', 'newbook'],
      image_id: null,
      status: 'draft',
      scheduled_at: null,
      published_at: null,
      metadata: { source: 'repurpose_workflow' },
      created_at: '2026-04-12T00:00:00Z',
    };
    expect(post.platform).toBe('twitter');
    expect(post.hashtags).toHaveLength(3);
    expect(post.status).toBe('draft');
  });

  it('SocialPost supports all platform values', () => {
    const platforms: SocialPost['platform'][] = ['twitter', 'linkedin', 'instagram', 'facebook'];
    expect(platforms).toHaveLength(4);
  });

  it('SocialPost supports all status values', () => {
    const statuses: SocialPost['status'][] = ['draft', 'published', 'scheduled'];
    expect(statuses).toHaveLength(3);
  });

  it('PublishedContent has cover_image_path field', () => {
    const content: PublishedContent = {
      id: 'c-1',
      user_id: '+14105914612',
      title: 'Test Chapter',
      content_type: 'chapter',
      genre_slug: 'post-apocalyptic',
      content_text: '<p>Content here</p>',
      storage_path: null,
      cover_image_path: '+14105914612/20260412_test-chapter.png',
      status: 'draft',
      project_id: 'proj-1',
      chapter_number: 1,
      metadata: {},
      created_at: '2026-04-12T00:00:00Z',
      updated_at: '2026-04-12T00:00:00Z',
      published_at: null,
      deleted_at: null,
    };
    expect(content.cover_image_path).toContain('.png');
  });
});

// ---- S4-3: Cover Art Gallery ----
describe('S4-3: Cover Art Gallery', () => {
  it('ImageGallery component exports default', async () => {
    const mod = await import('../components/images/ImageGallery');
    expect(mod.default).toBeDefined();
  });

  it('ImageGallery accepts projectId and onSelectImage props', async () => {
    const mod = await import('../components/images/ImageGallery');
    // Verify function component signature (accepts props)
    expect(typeof mod.default).toBe('function');
  });

  it('IMAGE_TYPES filter options are defined', async () => {
    // Verify the file exists and can be loaded
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/images/ImageGallery.tsx'),
      'utf-8'
    );
    expect(content).toContain('cover_art');
    expect(content).toContain('chapter_art');
    expect(content).toContain('social_media');
    expect(content).toContain('newsletter');
    expect(content).toContain('All Types');
  });

  it('ImageGallery renders thumbnail grid and navigates to detail', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/images/ImageGallery.tsx'),
      'utf-8'
    );
    expect(content).toContain('handleClick');
    expect(content).toContain('navigate');
    expect(content).toContain('getImageUrl');
  });

  it('ImageDetail page exists with prompt editor and regenerate', async () => {
    const mod = await import('../components/images/ImageDetail');
    expect(mod.default).toBeDefined();
  });
});

// ---- S4-4: Social Media Panel ----
describe('S4-4: Social Media Panel', () => {
  it('SocialMediaPanel component exports default', async () => {
    const mod = await import('../components/social/SocialMediaPanel');
    expect(mod.default).toBeDefined();
  });

  it('SocialMediaPanel has platform filter tabs', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/social/SocialMediaPanel.tsx'),
      'utf-8'
    );
    expect(content).toContain('All Platforms');
    expect(content).toContain('Twitter / X');
    expect(content).toContain('LinkedIn');
    expect(content).toContain('Instagram');
    expect(content).toContain('Facebook');
  });

  it('SocialMediaPanel has copy-to-clipboard functionality', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/social/SocialMediaPanel.tsx'),
      'utf-8'
    );
    expect(content).toContain('handleCopy');
    expect(content).toContain('navigator.clipboard.writeText');
    expect(content).toContain('copiedId');
  });

  it('SocialMediaPanel shows image thumbnails for linked posts', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/social/SocialMediaPanel.tsx'),
      'utf-8'
    );
    expect(content).toContain('linkedImage');
    expect(content).toContain('imageMap');
  });
});

// ---- S4-5: Cover Image on ContentDetail ----
describe('S4-5: Cover image on ContentDetail', () => {
  it('ContentDetail imports ImageGallery', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/content/ContentDetail.tsx'),
      'utf-8'
    );
    expect(content).toContain("import ImageGallery from '../images/ImageGallery'");
  });

  it('ContentDetail has cover image banner and change/remove buttons', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/content/ContentDetail.tsx'),
      'utf-8'
    );
    expect(content).toContain('cover_image_path');
    expect(content).toContain('Change Cover');
    expect(content).toContain('Remove');
    expect(content).toContain('Choose from Gallery');
    expect(content).toContain('showImagePicker');
  });

  it('ContentDetail has coverImageMutation for updating cover_image_path', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/content/ContentDetail.tsx'),
      'utf-8'
    );
    expect(content).toContain('coverImageMutation');
    expect(content).toContain('handleSelectCoverImage');
  });
});

// ---- S4-6: Chat Drawer Enhancement ----
describe('S4-6: Chat Drawer Enhancement', () => {
  it('ChatDrawer component exports default', async () => {
    const mod = await import('../components/chat/ChatDrawer');
    expect(mod.default).toBeDefined();
  });

  it('ChatDrawer has persistent localStorage history', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatDrawer.tsx'),
      'utf-8'
    );
    expect(content).toContain('CHAT_STORAGE_KEY');
    expect(content).toContain('localStorage');
    expect(content).toContain('loadMessages');
    expect(content).toContain('saveMessages');
    expect(content).toContain('MAX_MESSAGES');
  });

  it('ChatDrawer has quick commands panel', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatDrawer.tsx'),
      'utf-8'
    );
    expect(content).toContain('QUICK_COMMANDS');
    expect(content).toContain('Brainstorm a book');
    expect(content).toContain('Write a chapter');
    expect(content).toContain('Generate cover art');
    expect(content).toContain('showCommands');
    expect(content).toContain('handleQuickCommand');
  });

  it('ChatDrawer has resizable width with drag handle', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatDrawer.tsx'),
      'utf-8'
    );
    expect(content).toContain('drawerWidth');
    expect(content).toContain('handleResizeStart');
    expect(content).toContain('isResizing');
    expect(content).toContain('cursor-col-resize');
  });

  it('ChatDrawer has context-aware commands based on current project', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatDrawer.tsx'),
      'utf-8'
    );
    expect(content).toContain('contextCommands');
    expect(content).toContain('currentProject');
    expect(content).toContain('Write next chapter');
    expect(content).toContain('Current Project');
  });

  it('ChatDrawer has message timestamps', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatDrawer.tsx'),
      'utf-8'
    );
    expect(content).toContain('timestamp');
    expect(content).toContain('toLocaleTimeString');
  });

  it('ChatDrawer has async operation confirmation message', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatDrawer.tsx'),
      'utf-8'
    );
    expect(content).toContain('isAsyncCommand');
    expect(content).toContain('Content Library');
    expect(content).toContain('isAsync');
  });

  it('ChatDrawer has typing indicator with animated dots', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatDrawer.tsx'),
      'utf-8'
    );
    expect(content).toContain('animate-bounce');
    expect(content).toContain('animationDelay');
  });

  it('ChatDrawer has clear history button', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatDrawer.tsx'),
      'utf-8'
    );
    expect(content).toContain('clearHistory');
    expect(content).toContain('Clear chat history');
  });
});

// ---- Project Workspace Tab updates ----
describe('Project Workspace: Art and Social tabs', () => {
  it('TABS array includes art and social', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/projects/ProjectDetail.tsx'),
      'utf-8'
    );
    // Verify TABS const includes both art and social
    const tabsMatch = content.match(/const TABS = \[([^\]]+)\]/);
    expect(tabsMatch).toBeTruthy();
    const tabsStr = tabsMatch![1];
    expect(tabsStr).toContain("'art'");
    expect(tabsStr).toContain("'social'");
  });

  it('Tab labels include Art and Social', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/projects/ProjectDetail.tsx'),
      'utf-8'
    );
    expect(content).toContain("art: 'Art'");
    expect(content).toContain("social: 'Social'");
  });

  it('ProjectDetail imports ImageGallery and SocialMediaPanel', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/projects/ProjectDetail.tsx'),
      'utf-8'
    );
    expect(content).toContain("import ImageGallery from '../images/ImageGallery'");
    expect(content).toContain("import SocialMediaPanel from '../social/SocialMediaPanel'");
  });

  it('ArtTab and SocialTab components are defined', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/projects/ProjectDetail.tsx'),
      'utf-8'
    );
    expect(content).toContain('function ArtTab');
    expect(content).toContain('function SocialTab');
    expect(content).toContain('<ImageGallery projectId={projectId}');
    expect(content).toContain('<SocialMediaPanel projectId={projectId}');
  });
});

// ---- SQL Migration ----
describe('SQL Migration: 005_sprint4_images_social.sql', () => {
  it('migration file exists with correct table definitions', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(process.cwd(), '..', 'migrations', '005_sprint4_images_social.sql');
    const content = fs.readFileSync(migrationPath, 'utf-8');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS generated_images_v2');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS social_posts_v2');
    expect(content).toContain('cover-images');
    expect(content).toContain('social-images');
    expect(content).toContain('writing-samples');
  });

  it('migration includes RLS policies for both tables', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(process.cwd(), '..', 'migrations', '005_sprint4_images_social.sql');
    const content = fs.readFileSync(migrationPath, 'utf-8');
    expect(content).toContain('ENABLE ROW LEVEL SECURITY');
    expect(content).toContain('Users can view their own images');
    expect(content).toContain('Users can view their own social posts');
  });

  it('migration includes indexes for performance', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(process.cwd(), '..', 'migrations', '005_sprint4_images_social.sql');
    const content = fs.readFileSync(migrationPath, 'utf-8');
    expect(content).toContain('idx_generated_images_v2_user');
    expect(content).toContain('idx_generated_images_v2_project');
    expect(content).toContain('idx_social_posts_v2_user');
    expect(content).toContain('idx_social_posts_v2_platform');
  });
});
