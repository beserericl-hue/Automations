export const N8N_WEBHOOK_URL = import.meta.env.VITE_N8N_WEBHOOK_URL || '';
export const ELEVENLABS_AGENT_ID = import.meta.env.VITE_ELEVENLABS_AGENT_ID || '';

export const CONTENT_TYPES = [
  'short_story',
  'blog_post',
  'newsletter',
  'chapter',
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_STATUSES = [
  'draft',
  'approved',
  'published',
  'rejected',
  'scheduled',
] as const;

export type ContentStatus = (typeof CONTENT_STATUSES)[number];
