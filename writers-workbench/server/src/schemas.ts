import { z } from 'zod';

const PAGE_SIZE_VALUES = [
  '5x8', '5.06x7.81', '5.25x8', '5.5x8.5', '6x9', '6.14x9.21',
  '6.69x9.61', '7x10', '7.44x9.69', '7.5x9.25', '8x10', '8.25x11',
  '8.25x6', '8.25x8.25', '8.27x11.69', '8.5x11', '8.5x8.5',
] as const;

export const ExportRequestSchema = z.object({
  project_id: z.string().uuid('project_id must be a valid UUID'),
  page_size: z.enum(PAGE_SIZE_VALUES).optional().default('6x9'),
});

export const ChatProxySchema = z.object({
  user_message_request: z.string().min(1, 'Message is required').max(5000, 'Message too long (max 5000 chars)'),
  user_id: z.string().min(1, 'user_id is required'),
});

export const BrainstormParseSchema = z.object({
  content_text: z.string().min(10, 'Content too short').max(50000, 'Content too long (max 50000 chars)'),
});

export const BrainstormSubmitSchema = z.object({
  content_text: z.string().min(10, 'Content too short').max(50000, 'Content too long (max 50000 chars)'),
  title: z.string().min(1, 'Title is required').max(200),
  genre_slug: z.string().min(1, 'Genre is required'),
  story_arc: z.string().min(1, 'Story arc is required'),
  target_chapter_count: z.coerce.number().int().min(1).max(100).optional(),
  themes: z.string().optional(),
});

export const AdminUserSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Phone must be E.164 format (e.g. +14105551234)'),
  display_name: z.string().min(1, 'Display name is required').max(100),
  email: z.string().email('Invalid email address'),
  role: z.enum(['user', 'admin', 'editor', 'viewer']).optional().default('user'),
});

export const AdminUserUpdateSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  email: z.string().email('Invalid email address').optional(),
  role: z.enum(['user', 'admin', 'editor', 'viewer']).optional(),
});

export const DeleteAccountSchema = z.object({
  confirmation: z.literal('DELETE', { message: 'Must type DELETE to confirm' }),
});

// ============================================
// Email send endpoint (Postal — from PR #17)
// ============================================

const AttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(200),
  data: z.string().min(1), // base64
});

export const EmailSendSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
  subject: z.string().min(1, 'subject is required').max(998, 'subject too long'),
  html: z.string().min(1, 'html is required').max(500_000, 'html too large'),
  text: z.string().max(500_000).optional(),
  cc: z.union([z.string().email(), z.array(z.string().email()).max(20)]).optional(),
  bcc: z.union([z.string().email(), z.array(z.string().email()).max(20)]).optional(),
  replyTo: z.string().email().optional(),
  from: z.string().max(200).optional(),
  attachments: z.array(AttachmentSchema).max(10).optional(),
  user_id: z.string().optional(),
});

// ============================================
// Newsletter Migration sprint (S3 ingestion endpoints)
// ============================================

// Storage-key validation: rejects path traversal, absolute paths,
// null bytes, trailing file extensions, and anything Postgres
// text_pattern_ops won't play nicely with. Max 512 chars.
const ingestionKeyRegex = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\-/]+$/;
const IngestionKeySchema = z
  .string()
  .min(1, 'key is required')
  .max(512, 'key too long (max 512 chars)')
  .refine((v) => !v.includes('\0'), { message: 'key must not contain null bytes' })
  .refine((v) => ingestionKeyRegex.test(v), {
    message: 'key must be date/slug-style path (no .., no leading /, no special chars)',
  })
  .refine((v) => !/\.(md|html)$/i.test(v), {
    message: 'key must not include .md or .html extension (server appends)',
  });

export const IngestionTypeSchema = z.enum(['article', 'reddit_post', 'tweet', 'newsletter']);

export const IngestionUploadSchema = z.object({
  key: IngestionKeySchema,
  user_id: z.string().min(1, 'user_id is required'),
  type: IngestionTypeSchema,
  title: z.string().max(500).optional().nullable(),
  authors: z.string().max(500).optional().nullable(),
  source_name: z.string().min(1, 'source_name is required').max(200),
  source_url: z.string().url().max(2000).optional().nullable(),
  external_source_urls: z.array(z.string().url().max(2000)).max(100).optional().default([]),
  image_urls: z.array(z.string().url().max(2000)).max(100).optional().default([]),
  reddit_metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  published_timestamp: z.string().datetime({ offset: true }).optional().nullable(),
  feed_url: z.string().url().max(2000).optional().nullable(),
  // 10 MB caps match the newsletter-ingestion Storage bucket's file_size_limit
  // (migration 009). Raised from 5 MB after exec 13631 hit the cap on a CNN
  // article whose raw HTML (inline scripts + styles) exceeded 5 MB.
  markdown: z.string().max(10 * 1024 * 1024, 'markdown too large (max 10 MB)'),
  html: z.string().max(10 * 1024 * 1024, 'html too large (max 10 MB)'),
});

export const IngestionSearchQuerySchema = z.object({
  prefix: IngestionKeySchema,
  user_id: z.string().min(1, 'user_id is required'),
  type_not: IngestionTypeSchema.optional(),
});

// ============================================
// Newsletter Migration sprint (S9 approvals)
// ============================================

export const ApprovalStageSchema = z.enum(['stories', 'subject_line']);

export const ApprovalCreateSchema = z.object({
  user_id: z.string().min(1, 'user_id is required'),
  stage: ApprovalStageSchema,
  payload: z.record(z.string(), z.unknown()),
  resume_url: z
    .string()
    .url('resume_url must be a valid URL')
    .max(4096, 'resume_url too long'),
  execution_id: z.string().min(1, 'execution_id is required').max(200),
});

export const ApprovalResolveSchema = z.object({
  decision: z.enum(['approve', 'revise']),
  feedback: z.string().max(5000).optional().default(''),
});

// ============================================
// Newsletter Migration sprint (S11 newsletter-sends save)
// ============================================

// ============================================
// Sprint 8: RBAC, subscription tiers, credits
// ============================================

const PhoneE164 = z.string().regex(/^\+[1-9]\d{1,14}$/, 'Phone must be E.164 format (e.g. +14105551234)');

export const CreditPurchaseSchema = z.object({
  amount: z.coerce.number().int().min(1, 'amount must be at least 1').max(10000, 'max 10000 per purchase'),
});

export const ImpersonateStartSchema = z.object({
  target_user_id: PhoneE164,
  reason: z.string().max(500).optional(),
});

const TierFeaturesSchema = z.object({
  kdp_export: z.boolean().optional(),
  cover_art: z.boolean().optional(),
  social_media: z.boolean().optional(),
  max_projects: z.number().int().min(0).optional(),
}).catchall(z.union([z.boolean(), z.number(), z.string()]));

export const TierCreateSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, 'name must be lowercase a-z, 0-9, _'),
  display_name: z.string().min(1).max(100),
  description: z.string().max(1000).optional().nullable(),
  monthly_credits: z.number().int().min(0).max(100000),
  monthly_price_cents: z.number().int().min(0).max(100000000),
  annual_price_cents: z.number().int().min(0).max(100000000),
  credit_purchase_price_cents: z.number().int().min(1).max(100000).optional().default(100),
  features: TierFeaturesSchema.optional().default({}),
  is_default: z.boolean().optional().default(false),
  publicly_selectable: z.boolean().optional().default(true),
  trial_days: z.number().int().min(0).max(365).optional().default(0),
  sort_order: z.number().int().optional().default(0),
  active: z.boolean().optional().default(true),
});

export const TierUpdateSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
  monthly_credits: z.number().int().min(0).max(100000).optional(),
  monthly_price_cents: z.number().int().min(0).max(100000000).optional(),
  annual_price_cents: z.number().int().min(0).max(100000000).optional(),
  credit_purchase_price_cents: z.number().int().min(1).max(100000).optional(),
  features: TierFeaturesSchema.optional(),
  publicly_selectable: z.boolean().optional(),
  trial_days: z.number().int().min(0).max(365).optional(),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
  // Server-side flag (UI sends it) — does not persist on subscription_tiers.
  _apply_credit_change_to_existing: z.boolean().optional(),
});

export const SuperuserConfigSchema = z.object({
  credit_costs: z.record(z.string(), z.number().int().min(0).max(1000)).optional(),
  maintenance_mode: z.boolean().optional(),
  default_tier_name: z.string().min(1).max(50).optional(),
  trial_duration_days_override: z.number().int().min(0).max(365).optional(),
}).catchall(z.unknown());

export const LockAccountSchema = z.object({
  reason: z.string().min(1, 'lock reason required').max(500),
});

export const AdjustCreditsSchema = z.object({
  delta: z.coerce.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.string().min(1).max(500),
});

export const ChangeSubscriptionSchema = z.object({
  tier_name: z.string().min(1).max(50),
  billing_cycle: z.enum(['monthly', 'annual', 'none']).optional(),
  reset_credits: z.boolean().optional().default(true),
});

export const CreateUserWithSubscriptionSchema = z.object({
  phone: PhoneE164,
  display_name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(['user', 'admin', 'editor', 'viewer']).optional().default('user'),
  // Subscription
  tier_name: z.string().min(1).max(50),
  billing_cycle: z.enum(['monthly', 'annual', 'none']).optional().default('none'),
  is_free: z.boolean().optional().default(false),
});

export const SignupSubscribeSchema = z.object({
  tier_name: z.string().min(1).max(50),
  billing_cycle: z.enum(['monthly', 'annual', 'none']).optional().default('none'),
});

export const RoleChangeSchema = z.object({
  // Sprint 8: 'superuser' and 'admin' write to user_role_meta_v2; 'user' deletes
  // any existing meta row. Only a superuser caller may grant 'admin' or
  // 'superuser' (enforced in the route handler).
  role: z.enum(['user', 'admin', 'superuser']),
  notes: z.string().max(500).optional(),
});

/**
 * Hotfix (2026-04-28): one-shot admin update covering profile fields,
 * app_config_v2 email overrides, and password reset. All fields optional —
 * the route only updates what's present. Password reset goes through the
 * Supabase Auth admin API; the rest are direct table updates.
 */
export const AdminUserFullUpdateSchema = z
  .object({
    display_name: z.string().min(1).max(100).optional(),
    email: z.string().email('Invalid email address').optional().nullable(),
    recipient_email: z.string().email('Invalid recipient email').optional().nullable().or(z.literal('')),
    bcc_email: z.string().email('Invalid bcc email').optional().nullable().or(z.literal('')),
    password: z.string().min(8, 'Password must be at least 8 characters').optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field must be provided',
  });

export const NewsletterSendSaveSchema = z.object({
  user_id: z.string().min(1, 'user_id is required'),
  send_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'send_date must be YYYY-MM-DD'),
  subject: z.string().min(1, 'subject is required').max(998),
  preheader: z.string().max(500).optional().nullable(),
  html_body: z.string().min(1, 'html_body is required').max(5 * 1024 * 1024),
  markdown_body: z.string().max(5 * 1024 * 1024).optional().nullable(),
  // Optional explicit schedule time. If missing, server defaults to now()+24h.
  scheduled_send_at: z.string().datetime({ offset: true }).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

// ============================================
// Compose Newsletter 2a (S2 — generate + status)
// ============================================

// `edition_id` follows the same shape as the seeded `ai-news` row in
// migration 012 — short, slug-style, lowercase letters/digits/hyphens.
const EditionIdSchema = z
  .string()
  .min(1, 'edition_id is required')
  .max(64, 'edition_id too long')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'edition_id must be slug-style (lowercase, digits, hyphens)');

export const GenerateSchema = z.object({
  edition_id: EditionIdSchema,
  send_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'send_date must be YYYY-MM-DD'),
  // Optional. Forwarded to the n8n workflow as the "Previous Newsletter Content"
  // field, which the LLM uses to avoid duplicate coverage. Capped at 1MB to
  // prevent accidental megabyte-sized pastes from blowing past the express
  // body limit.
  previous_newsletter_content: z
    .string()
    .max(1024 * 1024, 'previous_newsletter_content too large (max 1 MB)')
    .optional()
    .default(''),
});

// Used as a path-param validator for endpoints that take an edition id.
export const NewsletterEditionIdParamSchema = z.object({
  id: EditionIdSchema,
});

// ============================================
// Migration 013 — per-genre user ingestion URLs
// ============================================

export const GenreIngestionUrlTypeSchema = z.enum(['rss', 'source', 'subreddit', 'goodreads']);
export const GenreIngestionUrlVisibilitySchema = z.enum(['public', 'private']);

// Slug shape mirrors the existing genre_slug values seeded in genre_config_v2.
const GenreSlugSchema = z
  .string()
  .min(1, 'genre_slug is required')
  .max(64, 'genre_slug too long')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'genre_slug must be slug-style (lowercase, digits, hyphens)');

export const GenreSlugParamSchema = z.object({
  slug: GenreSlugSchema,
});

export const GenreUrlIdParamSchema = z.object({
  slug: GenreSlugSchema,
  id: z.string().uuid('id must be a UUID'),
});

export const AddGenreUrlSchema = z.object({
  url: z
    .string()
    .url('url must be a valid URL')
    .max(2000, 'url too long')
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'url must use http or https' },
    ),
  url_type: GenreIngestionUrlTypeSchema,
  label: z.string().max(200).optional().nullable(),
  // Defaults to private. Setting 'public' is enforced by the route — only
  // admin/superuser callers may pass 'public'; anyone else is rejected
  // before the insert reaches Postgres.
  visibility: GenreIngestionUrlVisibilitySchema.optional().default('private'),
});

// ============================================
// Compose Newsletter 2a (S3 — n8n stage-emit callback)
// ============================================

// Stage values mirror the 9 emit_stage_* nodes in `Content - Newsletter Agent V2`.
// New stages can be added without a server change as long as the n8n side
// passes a slug-style string — but listing them here gives the server an
// authoritative whitelist so a typo on the n8n side surfaces as a 400
// rather than silently fanning out to the SSE channel.
export const NewsletterStageSchema = z.enum([
  'gathering',
  'selecting_stories',
  'awaiting_stories_approval',
  'stories_approved',
  'awaiting_subject_approval',
  'subject_approved',
  'writing_segment',
  'segments_done',
  'saved',
  'error',
]);

export const StageCallbackSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  executionId: z.string().min(1, 'executionId is required').max(200),
  editionId: EditionIdSchema,
  stage: NewsletterStageSchema,
  detail: z.string().max(1000).optional().default(''),
  ts: z.string().datetime({ offset: true }),
});
