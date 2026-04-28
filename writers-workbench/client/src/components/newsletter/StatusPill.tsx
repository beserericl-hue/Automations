/**
 * Compact status pill for newsletter sends + execution stages. The map
 * below covers everything `newsletter_sends_v2.status` can hold plus the
 * 9 stage values the SSE stream emits, so the same component works on
 * both the Home page (sends list) and the Execution Status page (S7).
 */
import type { NewsletterSendStatus } from '../../types/database';
import type { NewsletterStage } from '../../lib/newsletter/schema';

type Status = NewsletterSendStatus | NewsletterStage | 'in_flight' | 'unknown';

const STYLE_MAP: Record<Status, string> = {
  // Send statuses
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  scheduled: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  sending: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  sent: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  cancelled: 'bg-gray-100 text-gray-500 line-through dark:bg-gray-800 dark:text-gray-500',
  // Stage values
  gathering: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  selecting_stories: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  awaiting_stories_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  stories_approved: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  awaiting_subject_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  subject_approved: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  writing_segment: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  segments_done: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  saved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  // Synthetic
  in_flight: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  unknown: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

const LABEL_MAP: Partial<Record<Status, string>> = {
  awaiting_stories_approval: 'awaiting stories',
  awaiting_subject_approval: 'awaiting subject',
  stories_approved: 'stories approved',
  subject_approved: 'subject approved',
  writing_segment: 'writing',
  segments_done: 'segments done',
  selecting_stories: 'selecting',
  in_flight: 'in flight',
};

export default function StatusPill({ status }: { status: string }) {
  const key = (status in STYLE_MAP ? status : 'unknown') as Status;
  const label = LABEL_MAP[key] ?? String(key).replace(/_/g, ' ');
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STYLE_MAP[key]}`}
      title={status}
    >
      {label}
    </span>
  );
}
