/**
 * Chat-message classifier for the BullMQ queue layer.
 *
 * Mirrors the decision logic in the n8n hub's `preprocess_message` code
 * node: detect operation type from the raw user message, route to the
 * right priority tier (and thus queue), assign a BullMQ numeric
 * priority.
 *
 * The patterns here intentionally stay coarse — the server-side
 * classifier only has to answer "which queue" and "how urgent". The hub
 * itself still runs its richer classification for tool selection.
 */

import {
  PRIORITY_BY_TIER,
  QUEUE_BY_TIER,
  type PriorityTier,
  type QueueName,
} from './types.js';

export interface Classification {
  tier: PriorityTier;
  queue: QueueName;
  /** BullMQ numeric priority (1 = highest). */
  priority: number;
  /** Short tag for job_queue_v2.job_type — "list_outlines", "write_chapter", etc. */
  jobType: string;
}

// --------------------------------------------------------------------
// Pattern library — ordered by specificity. First match wins.
//
// These mirror the hub's preprocess_message regexes. Whenever the hub's
// regexes change, update here too (or they'll drift).

interface Rule {
  test: RegExp;
  tier: PriorityTier;
  jobType: string;
}

const RULES: Rule[] = [
  // ---------- sync: retrieve / list / revert / approve ----------
  {
    test: /\b(list|show|display)\s+(?:(?:all|my|the)\s+)?(outlines?|drafts?|projects?|story\s+arcs?|chapters?)\b/i,
    tier: 'sync',
    jobType: 'list_content',
  },
  {
    test: /\boutline\s+version\s+history\b/i,
    tier: 'sync',
    jobType: 'outline_versions',
  },
  {
    test: /\brevert\s+outline\b/i,
    tier: 'sync',
    jobType: 'revert_outline',
  },
  {
    test: /\b(retrieve|pull\s+up|get|fetch|open)\s+/i,
    tier: 'sync',
    jobType: 'retrieve_content',
  },
  {
    test: /\b(approve|publish|reject|schedule)\s+/i,
    tier: 'sync',
    jobType: 'content_action',
  },
  // ---------- heavy: long-running content generation ----------
  {
    test: /\bwrite\s+(the\s+)?(chapter|prologue|epilogue)\b/i,
    tier: 'heavy',
    jobType: 'write_chapter',
  },
  {
    test: /\bwrite\s+(a\s+)?short\s+story\b/i,
    tier: 'heavy',
    jobType: 'write_short_story',
  },
  {
    test: /\bQ[\/\s]*A|quality\s+(check|assurance)\b/i,
    tier: 'heavy',
    jobType: 'qa_chapter',
  },
  // ---------- medium: brainstorm / edit / blog / newsletter ----------
  {
    test: /\b(brainstorm|outline)\s+.*\b(story|chapter|book|novel)\b/i,
    tier: 'medium',
    jobType: 'brainstorm_story',
  },
  {
    test: /\bedit\s+(the\s+)?outline\b/i,
    tier: 'medium',
    jobType: 'edit_outline',
  },
  {
    test: /\bwrite\s+(a\s+)?blog(\s+post)?\b/i,
    tier: 'medium',
    jobType: 'write_blog',
  },
  {
    test: /\b(write\s+)?newsletter\b/i,
    tier: 'medium',
    jobType: 'write_newsletter',
  },
  {
    test: /\bresearch(\s+report)?\b/i,
    tier: 'medium',
    jobType: 'research_report',
  },
  // ---------- background: assets / analytics / side effects ----------
  {
    test: /\b(cover\s+art|generate\s+cover)\b/i,
    tier: 'background',
    jobType: 'cover_art',
  },
  {
    test: /\brepurpose\b.*\bsocial\b/i,
    tier: 'background',
    jobType: 'repurpose_social',
  },
  {
    test: /\bkindle\b|\bformat\s+(the\s+)?(book|ebook)\b/i,
    tier: 'background',
    jobType: 'format_kindle',
  },
];

/** Default when nothing matches — chat/brainstorm catch-all. */
const DEFAULT: Rule = {
  test: /(?:)/, // always-match placeholder, never consulted
  tier: 'medium',
  jobType: 'chat_generic',
};

/**
 * Classify a raw user message.
 *
 * Returns the tier, queue name, BullMQ priority, and a job_type tag for
 * audit. Always returns a value — unmatched messages fall to
 * medium-ops/chat_generic.
 */
export function classifyJob(userMessage: string): Classification {
  const msg = (userMessage || '').trim();
  const rule = RULES.find((r) => r.test.test(msg)) ?? DEFAULT;
  return {
    tier: rule.tier,
    queue: QUEUE_BY_TIER[rule.tier],
    priority: PRIORITY_BY_TIER[rule.tier],
    jobType: rule.jobType,
  };
}

/** Export for tests / admin tooling. */
export const CLASSIFIER_RULES = RULES;
