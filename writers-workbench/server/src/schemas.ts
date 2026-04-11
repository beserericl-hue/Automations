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

export const AdminUserSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Phone must be E.164 format (e.g. +14105551234)'),
  display_name: z.string().min(1, 'Display name is required').max(100),
  email: z.string().email('Invalid email address'),
});
