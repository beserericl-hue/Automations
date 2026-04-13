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
