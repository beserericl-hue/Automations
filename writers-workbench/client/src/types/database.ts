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
  deleted_at: string | null;
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
  arc_notes?: string;
  research_topics?: string[];
  // chapter_outline can be either:
  // - an object with sub_chapters array (from brainstorm_chapter workflow)
  // - an array of SubChapter (legacy format)
  chapter_outline?: ChapterOutline | SubChapter[];
}

export interface ChapterOutline {
  chapter_title?: string;
  chapter_number?: number | string;
  chapter_summary?: string;
  chapter_story_arc?: string;
  book_arc_beat?: string;
  sub_chapters: SubChapter[];
  created_at?: string;
  updated_at?: string;
  version?: number;
}

export interface SubChapter {
  number?: number;
  section_number?: number; // legacy field
  title: string;
  brief: string;
  characters?: string[];
  arc_beat?: string;
  setting?: string;
  emotional_tone?: string;
  connects_to_book_arc?: string;
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
  deleted_at: string | null;
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
  deleted_at: string | null;
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
  deleted_at: string | null;
}

export interface AppConfig {
  id: string;
  user_id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface TokenUsage {
  id: string;
  user_id: string;
  workflow_name: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface GeneratedImage {
  id: string;
  user_id: string;
  content_id: string | null;
  project_id: string | null;
  image_type: 'cover_art' | 'chapter_art' | 'social_media' | 'newsletter_section';
  platform: 'twitter' | 'linkedin' | 'instagram' | 'facebook' | null;
  storage_path: string;
  thumbnail_path: string | null;
  original_prompt: string | null;
  genre_slug: string | null;
  image_format: string;
  width: number | null;
  height: number | null;
  file_size_bytes: number | null;
  generation_model: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SocialPost {
  id: string;
  user_id: string;
  source_content_id: string | null;
  project_id: string | null;
  platform: 'twitter' | 'linkedin' | 'instagram' | 'facebook';
  post_text: string;
  hashtags: string[];
  image_id: string | null;
  status: 'draft' | 'published' | 'scheduled';
  scheduled_at: string | null;
  published_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ContentUsage {
  id: string;
  user_id: string;
  content_id: string;
  output_type: string;
  output_title: string;
  output_date: string;
  project_id: string | null;
  created_at: string;
  // Joined from content_index
  source_title?: string;
  source_type?: string;
  source_url?: string;
  scraped_at?: string;
}

export interface QACheck {
  name: string;
  status: 'PASS' | 'NEEDS_REVIEW';
  details: string;
}

export interface QAReport {
  generated_at: string;
  overall_status: 'PASS' | 'NEEDS_REVIEW';
  checks: QACheck[];
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

export type ContentIngestionType = 'article' | 'reddit_post' | 'tweet' | 'newsletter';

export interface RedditMetadata {
  score?: number;
  num_comments?: number;
  author?: string;
  subreddit?: string;
  reddit_id?: string;
  flair?: string | null;
}

export interface ContentIngestion {
  id: string;
  key: string;
  user_id: string;
  type: ContentIngestionType;
  title: string | null;
  authors: string | null;
  source_name: string;
  source_url: string | null;
  external_source_urls: string[];
  image_urls: string[];
  reddit_metadata: RedditMetadata | null;
  published_timestamp: string | null;
  feed_url: string | null;
  storage_path_md: string;
  storage_path_html: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type NewsletterApprovalStage = 'stories' | 'subject_line';
export type NewsletterApprovalDecision = 'approve' | 'revise';

export interface NewsletterApproval {
  id: string;
  token: string;
  user_id: string;
  execution_id: string;
  resume_url: string;
  stage: NewsletterApprovalStage;
  payload: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
  decision: NewsletterApprovalDecision | null;
  feedback: string | null;
  // Compose Newsletter 2a (migration 012). Backfilled to 'ai-news' on
  // existing rows; required for new rows once S2/S3 wire up the route.
  edition_id: string | null;
}

// Compose Newsletter 2a — newsletter editions (migration 012)
export interface NewsletterEdition {
  id: string;
  display_name: string;
  subheader: string;
  genre: string;
  description: string | null;
  newsletter_name: string;
  primary_color: string;
  paper_color: string;
  enabled: boolean;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export type NewsletterSendStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface NewsletterSend {
  id: string;
  user_id: string;
  send_date: string;
  subject: string;
  preheader: string | null;
  html_body: string;
  markdown_body: string | null;
  scheduled_send_at: string | null;
  status: NewsletterSendStatus;
  sent_at: string | null;
  recipient_count: number | null;
  delivery_provider: string | null;
  provider_message_id: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Compose Newsletter 2a (migration 012). Backfilled to 'ai-news' on
  // existing rows. execution_id is the n8n execution id captured by the
  // webhook trigger's Respond to Webhook node (S3). issue_number is
  // assigned at save time in Phase 2b.
  edition_id: string | null;
  execution_id: string | null;
  issue_number: number | null;
}
