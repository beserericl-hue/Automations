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
