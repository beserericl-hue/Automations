// TypeScript types matching the V2 Supabase schema (supabase_setup_v2.sql)

// Legacy column on users_v2.role (frozen by migration 001 CHECK constraint).
// Sprint 8 adds 'superuser' as an effective role via the user_role_meta_v2
// table — the legacy column never holds 'superuser'.
export type LegacyUserRole = 'user' | 'admin' | 'editor' | 'viewer';
export type EffectiveUserRole = 'user' | 'admin' | 'superuser';
export type AccountStatus = 'active' | 'locked' | 'suspended' | 'pending';

export interface UserProfile {
  id: string;
  user_id: string; // phone number (E.164) — primary key across all V2 tables
  phone_number: string;
  display_name: string | null;
  email: string | null;
  bcc_email: string | null;
  preferences: Record<string, unknown>;
  role: LegacyUserRole;
  // Sprint 8: effective role from COALESCE(user_role_meta_v2.role, users_v2.role).
  // Surfaced by the server / client query; not stored on users_v2 directly.
  effective_role?: EffectiveUserRole;
  // Sprint 8: from user_account_meta_v2; defaults to 'active' when no meta row exists.
  account_status?: AccountStatus;
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
}

// =====================================================================
// Sprint 8: RBAC, subscription tiers, credits, impersonation
// =====================================================================

export interface UserAccountMeta {
  user_id: string;
  account_status: AccountStatus;
  locked_at: string | null;
  locked_by: string | null;
  locked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRoleMeta {
  user_id: string;
  role: 'superuser' | 'admin';
  granted_at: string;
  granted_by: string | null;
  notes: string | null;
}

export interface TierFeatures {
  kdp_export: boolean;
  cover_art: boolean;
  social_media: boolean;
  max_projects: number;
  [key: string]: boolean | number | string;
}

export type TierName = 'standard' | 'pro' | 'trial' | 'paid_full' | 'free_full' | string;

export interface SubscriptionTier {
  id: string;
  name: TierName;
  display_name: string;
  description: string | null;
  monthly_credits: number;
  monthly_price_cents: number;
  annual_price_cents: number;
  credit_purchase_price_cents: number;
  features: TierFeatures;
  is_default: boolean;
  publicly_selectable: boolean;
  trial_days: number;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type SubscriptionStatus = 'active' | 'expired' | 'cancelled' | 'past_due';
export type BillingCycle = 'monthly' | 'annual' | 'none';

export interface UserSubscription {
  id: string;
  user_id: string;
  tier_id: string;
  status: SubscriptionStatus;
  billing_cycle: BillingCycle;
  current_period_start: string;
  current_period_end: string | null;
  trial_start: string | null;
  trial_end: string | null;
  credits_remaining: number;
  credits_used_this_period: number;
  auto_renew: boolean;
  trial_warnings_sent: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Joined view returned by the server when fetching the current user's subscription.
export interface UserSubscriptionWithTier extends UserSubscription {
  tier: SubscriptionTier;
}

export type CreditTransactionType =
  | 'monthly_reset'
  | 'usage'
  | 'admin_adjustment'
  | 'purchase'
  | 'refund';

export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  balance_after: number;
  transaction_type: CreditTransactionType;
  description: string | null;
  reference_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ImpersonationLog {
  id: string;
  superuser_id: string;
  target_user_id: string;
  started_at: string;
  ended_at: string | null;
  reason: string | null;
  actions_taken: Array<Record<string, unknown>>;
}
