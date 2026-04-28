/**
 * Compose Newsletter 2a — client-side type surface.
 *
 * Database row types live in client/src/types/database.ts and were verified
 * column-by-column against DEV Supabase (gvbvwcnmjkdpclcisqrr) on 2026-04-28
 * after migrations 001..012 had landed. They are NOT redefined here — re-exported
 * so newsletter components have a single import source for everything they need.
 *
 * The new types in this file are SSE event payload shapes. They mirror what
 * the server publishes from:
 *   - server/src/routes/newsletter.ts  (newsletter.stage)
 *   - server/src/routes/approvals.ts   (newsletter.approval.created / .resolved)
 *
 * Stage values must match server/src/schemas.ts::NewsletterStageSchema.
 */
export type {
  NewsletterEdition,
  NewsletterSend,
  NewsletterSendStatus,
  NewsletterApproval,
  NewsletterApprovalStage,
  NewsletterApprovalDecision,
  ContentIngestion,
} from '../../types/database';

// ---------------------------------------------------------------------------
// Stage values — must stay in sync with server/src/schemas.ts NewsletterStageSchema.
// ---------------------------------------------------------------------------

export type NewsletterStage =
  | 'gathering'
  | 'selecting_stories'
  | 'awaiting_stories_approval'
  | 'stories_approved'
  | 'awaiting_subject_approval'
  | 'subject_approved'
  | 'writing_segment'
  | 'segments_done'
  | 'saved'
  | 'error';

/** Ordered list used by progress strips in S7. `error` is an overlay, not a step. */
export const NEWSLETTER_STAGE_ORDER: readonly Exclude<NewsletterStage, 'error'>[] = [
  'gathering',
  'selecting_stories',
  'awaiting_stories_approval',
  'stories_approved',
  'awaiting_subject_approval',
  'subject_approved',
  'writing_segment',
  'segments_done',
  'saved',
] as const;

// ---------------------------------------------------------------------------
// SSE event payloads — what the server broadcasts on the user's session channel.
// ---------------------------------------------------------------------------

export interface NewsletterStageEventData {
  userId: string;
  executionId: string;
  editionId: string;
  stage: NewsletterStage;
  detail: string;
  ts: string;
}

export interface NewsletterApprovalCreatedEventData {
  token: string;
  stage: import('../../types/database').NewsletterApprovalStage;
  execution_id: string;
  approval_url: string;
}

export interface NewsletterApprovalResolvedEventData {
  token: string;
  stage: import('../../types/database').NewsletterApprovalStage;
  execution_id: string;
  decision: import('../../types/database').NewsletterApprovalDecision;
  feedback: string;
  resumed: boolean;
}

export type NewsletterEvent =
  | { event: 'newsletter.stage';            data: NewsletterStageEventData }
  | { event: 'newsletter.approval.created'; data: NewsletterApprovalCreatedEventData }
  | { event: 'newsletter.approval.resolved'; data: NewsletterApprovalResolvedEventData };
