// TypeScript types matching the V2 Supabase schema (supabase_setup_v2.sql)

export interface UserProfile {
  id: string;
  user_id: string; // phone number (E.164) — primary key across all V2 tables
  phone_number: string;
  display_name: string | null;
  email: string | null;
  bcc_email: string | null;
  preferences: Record<string, unknown>;
  role: 'user' | 'admin' | 'editor' | 'viewer';
  supabase_auth_uid: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface GenreConfig {
  id: string;
  user_id: string | null; // null = public genre
  genre_name: string;
  genre_slug: string;
  description: string;
  keywords: string[];
  rss_feed_urls: string[];
  source_urls: string[];
  subreddit_names: string[];
  goodreads_shelves: string[];
  writing_guidelines: string;
  active: boolean;
  created_at: string;
}

export interface StoryArc {
  id: string;
  user_id: string | null; // null = public arc
  name: string;
  description: string;
  prompt_text: string;
  discovery_question: string | null;
  created_at: string;
  updated_at: string;
}

export interface WritingProject {
  id: string;
  user_id: string;
  project_type: string;
  title: string;
  genre_slug: string | null;
  status: string;
  outline: ProjectOutline | null;
  chapter_count: number;
  draft_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectOutline {
  title?: string;
  premise?: string;
  themes?: string[];
  story_arc_name?: string;
  characters?: OutlineCharacter[];
  chapters?: OutlineChapter[];
}

export interface OutlineCharacter {
  name: string;
  role: string;
  description: string;
  age?: number | string;
}

export interface OutlineChapter {
  number: number | string; // can be "Prologue" or "Epilogue"
  title: string;
  brief: string;
  chapter_outline?: SubChapter[];
}

export interface SubChapter {
  section_number: number;
  title: string;
  brief: string;
  characters?: string[];
  arc_beat?: string;
}

export interface StoryBibleEntry {
  id: string;
  user_id: string;
  project_id: string;
  entry_type: 'character' | 'event' | 'location' | 'timeline' | 'plot_thread' | 'world_rule';
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  chapter_introduced: number | null;
  last_chapter_seen: number | null;
  created_at: string;
  updated_at: string;
}

export interface PublishedContent {
  id: string;
  user_id: string;
  title: string;
  content_type: 'short_story' | 'blog_post' | 'newsletter' | 'chapter';
  genre_slug: string | null;
  content_text: string | null;
  storage_path: string | null;
  cover_image_path: string | null;
  status: 'draft' | 'approved' | 'published' | 'rejected' | 'scheduled';
  project_id: string | null;
  chapter_number: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface ContentVersion {
  id: string;
  user_id: string;
  content_id: string;
  version_number: number;
  content_text: string;
  changed_by: string;
  change_note: string | null;
  created_at: string;
}

export interface OutlineVersion {
  id: string;
  user_id: string;
  project_id: string;
  version_number: number;
  outline: ProjectOutline;
  revision_note: string | null;
  created_at: string;
}

export interface ResearchReport {
  id: string;
  user_id: string;
  topic: string;
  genre_slug: string | null;
  content: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AppConfig {
  id: string;
  user_id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface ContentIndex {
  id: string;
  genre_slug: string;
  source_type: string;
  feed_name: string | null;
  source_url: string | null;
  title: string;
  summary: string | null;
  content_path: string;
  scraped_at: string;
  metadata: Record<string, unknown>;
}
