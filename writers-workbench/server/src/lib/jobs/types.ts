/**
 * Job type + priority definitions for the BullMQ queue layer (S10b-2).
 *
 * Naming convention: the four queue names mirror the priority tiers so
 * the queue name alone tells you the expected concurrency / timeout
 * profile. Higher BullMQ priority number = LOWER priority (BullMQ treats
 * 1 as the highest).
 */

export type QueueName =
  | 'sync-ops'        // retrieve / list / lookup — fast, user is waiting
  | 'medium-ops'      // brainstorm / blog / newsletter / edit outline
  | 'heavy-ops'       // write_chapter / write_short_story / QA
  | 'background-ops'; // embed / token_track / cover_art / kindle / email send

export type PriorityTier = 'sync' | 'medium' | 'heavy' | 'background';

/**
 * Maps priority tier -> BullMQ numeric priority. BullMQ 1 = most important.
 * Leave gaps so individual jobs within a tier can nudge up/down.
 */
export const PRIORITY_BY_TIER: Record<PriorityTier, number> = {
  sync: 1,
  medium: 3,
  heavy: 5,
  background: 7,
};

export const QUEUE_BY_TIER: Record<PriorityTier, QueueName> = {
  sync: 'sync-ops',
  medium: 'medium-ops',
  heavy: 'heavy-ops',
  background: 'background-ops',
};

/** All queues in declaration order (useful for iteration / admin UI). */
export const ALL_QUEUE_NAMES: readonly QueueName[] = [
  'sync-ops',
  'medium-ops',
  'heavy-ops',
  'background-ops',
] as const;

/**
 * Per-queue runtime settings consumed by the Worker factory in S10b-3.
 * Values here are the contract; BullMQ Worker instances pull from this.
 */
export interface QueueSettings {
  /** Max concurrent jobs a single worker process will run. */
  concurrency: number;
  /** Per-job timeout in ms. BullMQ stalls past this and retries. */
  timeoutMs: number;
}

export const QUEUE_SETTINGS: Record<QueueName, QueueSettings> = {
  'sync-ops': { concurrency: 10, timeoutMs: 30_000 },
  'medium-ops': { concurrency: 4, timeoutMs: 120_000 },
  'heavy-ops': { concurrency: 2, timeoutMs: 1_200_000 },
  'background-ops': { concurrency: 3, timeoutMs: 300_000 },
};

// --------------------------------------------------------------------
// Job payload shapes

/** Base fields every job carries so downstream can route + audit. */
export interface JobBase {
  /** Application-level user id (users_v2.user_id — text, not uuid). */
  userId: string;
  /** Tag for the audit table job_type column. Short identifier. */
  jobType: string;
  /** Session/correlation id for log stitching. */
  requestId?: string;
}

/** A chat message from the user that needs routing + execution. */
export interface ChatJob extends JobBase {
  jobType: 'chat';
  userMessage: string;
  /** Already-classified queue so we don't re-classify in the worker. */
  targetQueue: QueueName;
}

/** Directly forwards a payload to the DEV/PROD n8n hub webhook. */
export interface N8nWebhookJob extends JobBase {
  webhookUrl: string;
  body: Record<string, unknown>;
}

/** Outbound email (S11 uses this shape when Postal migration lands). */
export interface EmailJob extends JobBase {
  jobType: 'email';
  to: string;
  subject: string;
  htmlBody: string;
}

/** Fire-and-forget background work — embed refresh, token rollups, etc. */
export interface BackgroundJob extends JobBase {
  jobType:
    | 'embed_project'
    | 'token_usage_rollup'
    | 'cover_art'
    | 'format_kindle';
  params: Record<string, unknown>;
}

/** Union of every job shape the server enqueues. */
export type AnyJob = ChatJob | N8nWebhookJob | EmailJob | BackgroundJob;

/** Return shape for workers — feeds result back into job_queue_v2. */
export interface JobResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}
