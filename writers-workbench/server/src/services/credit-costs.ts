// Sprint 8 (S8-6 / S8-7): credit cost lookup, configurable via
// app_config_global_v2.sprint8_superuser_config.credit_costs. Falls back to
// hard-coded defaults when no config row exists.
//
// Defaults match the spec ("Writing operations: 5 credits, Brainstorm: 3,
// Research: 2, Cover art: 10, Social repurpose: 3, list/retrieve: 0").

import { getGlobalJson } from '../lib/app-config.js';
import { logger } from '../lib/logger.js';

export const DEFAULT_CREDIT_COSTS: Record<string, number> = {
  // Writing operations
  write_chapter: 5,
  write_short_story: 5,
  write_blog: 5,
  write_blog_post: 5,
  write_newsletter: 5,
  // Brainstorm / outline
  brainstorm: 3,
  brainstorm_story: 3,
  brainstorm_chapter: 3,
  revise_outline: 3,
  // Research
  research: 2,
  // Cover art
  cover_art: 10,
  generate_cover_art: 10,
  // Social
  social_repurpose: 3,
  repurpose_to_social_posts: 3,
  // Sync ops — explicitly zero
  list_outlines: 0,
  retrieve_content: 0,
  approve_content: 0,
  list_story_arcs: 0,
  story_bible_edit: 0,
  chat_generic: 0,
  // More free sync ops the chat classifier / engine hub emit (library reads and state changes).
  list_content: 0,
  outline_versions: 0,
  revert_outline: 0,
  content_action: 0,
  create_project: 0,
  scrape_url: 0,
  // Editing / QA (owner decision 2026-11-03: these are no longer free). Priced from their measured
  // API cost on DEV (token_usage_v2) at the same credits-per-dollar as the chapter ops (~82 credits
  // per $1 of API cost: write_chapter 5 cr / $0.059, short story 5 / $0.061, plan 3 / $0.038):
  //   chapter.qa      avg $0.053 per run (487 runs)  -> 4
  //   chapter.repair  avg $0.043 per run (425 runs)  -> 4 (every repair entry point)
  //   humanize        StealthGPT bills ~2.15 words per input word at $0.0002 -> $0.043 per 100
  //                   words of the passage -> 4 credits PER STARTED 100 WORDS (see CREDIT_UNIT)
  qa_chapter: 4,
  repair_chapter: 4,
  humanize_passage: 4,
  // The copy assistant on the promotion / publishing fields (routes/copy-assist.ts): one draft or one
  // revision of ONE field (description, back cover, keywords, inside flap, dedication, author's note,
  // bio, announcement email...). Measured on DEV 2026-11-03 (token_usage_v2, operation copy-assist.*,
  // claude-opus-5-5, a 21-chapter book): 16 drafts averaged $0.021. The book's material is a cached
  // prefix, so the first draft in a 5-minute window pays the cache write ($0.060-$0.084) and the rest
  // read it ($0.005-$0.036). 3 credits = $0.037 at ~82 credits/$, the per-field cost of a typical
  // session of two or more drafts. "Draft all missing" is this x the fields drafted. "Also by" is free.
  promo_copy: 3,
  // Still explicitly zero: not charged on any entry point (not part of the 2026-11-03 decision).
  review_chapter: 0,
  format_kindle: 0, // the Export tab builds the .docx server-side, free
  email_content: 0,
  eve_callback: 0,
};

/**
 * Operation names that are NOT credit keys themselves, mapped to the key the equivalent
 * operation is charged under elsewhere. The chat classifier and the engine hub name operations
 * their own way ("research_report", "media.social-posts"); without this map those names missed
 * the table and were charged 0 while the same work through its own screen was charged.
 *
 * Rules (enforced by credit-costs-coverage.test.ts): every name the classifier, the engine catalog
 * or a route can emit resolves to an entry in DEFAULT_CREDIT_COSTS, an alias never shadows a key,
 * and every alias points at a key that exists.
 */
export const CREDIT_KEY_ALIASES: Record<string, string> = {
  // ---- chat classifier (server/src/lib/jobs/classifier.ts) ----
  research_report: 'research', // = POST /api/research/run
  repurpose_social: 'social_repurpose', // = social-generate / social-calendar
  edit_outline: 'revise_outline', // = POST /api/projects/:id/outline/revise

  // ---- engine hub catalog (engine/.../hub/catalog.py), as tool.op ----
  'library.list-outlines': 'list_outlines',
  'library.retrieve': 'retrieve_content',
  'library.lifecycle': 'content_action',
  'library.versions': 'outline_versions',
  'library.revert': 'revert_outline',
  'library.email-content': 'email_content',
  'story_bible.list': 'retrieve_content',
  'story_bible.add': 'story_bible_edit',
  'story_bible.update': 'story_bible_edit',
  'media.scrape-url': 'scrape_url',
  'media.cover-art': 'cover_art',
  'media.social-posts': 'social_repurpose',
  'chapter.write': 'write_chapter',
  'chapter.rewrite': 'write_chapter', // chapter-actions charges a rewrite as write_chapter
  'chapter.plan': 'brainstorm_chapter', // chapter-actions "outline" action -> engine plan op
  'chapter.repair': 'repair_chapter',
  'chapter.qa': 'qa_chapter',
  'chapter.review': 'review_chapter',
  'chapter.humanize-passage': 'humanize_passage', // = POST /api/content/:id/humanize
  'chapter.blog': 'write_blog',
  'chapter.newsletter': 'write_newsletter',
  'chapter.short-story': 'write_short_story',
  'brainstorm.story': 'brainstorm_story',
  'brainstorm.short-story': 'brainstorm',
  'brainstorm.revise-outline': 'revise_outline',
  'brainstorm.edit-outline': 'revise_outline',
  'brainstorm.create-project': 'create_project',
  'research.run': 'research',
  'notify.eve-callback': 'eve_callback',
  // ---- Content Studio (engine studio step; server/src/routes/content-studio.ts) ----
  // Drafting and revising are the radar drafting prompts, priced like the radar schedule route
  // (social_repurpose per topic). Reads, state changes, scheduling and the issue selection are free,
  // like library reads/lifecycle. No new price: pricing is a pending owner decision.
  'studio.generate': 'social_repurpose', // x topics drafted
  'studio.revise': 'social_repurpose', // x 1 (undo is not charged)
  'studio.email': 'email_content',
  'studio.slate': 'list_content',
  'studio.queue': 'list_content',
  'studio.update': 'content_action',
  'studio.schedule': 'content_action',
  'studio.issue': 'content_action',
  'studio.batch': 'social_repurpose', // x the topics drafted + drafts revised among its steps (assistantUnits)
};

/** Keys whose price is per unit rather than per operation; the route multiplies by the units. */
export const CREDIT_UNIT: Record<string, { words: number }> = {
  humanize_passage: { words: 100 },
};

/** Units of a humanize request: one per started 100 words, never less than one. */
export function humanizeUnits(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / CREDIT_UNIT.humanize_passage.words));
}

export type CreditGroup = 'Writing' | 'Brainstorm & outline' | 'Research' | 'Editing & QA' | 'Media & social' | 'Free operations';

/**
 * What the superuser panel shows for each key. Every key in DEFAULT_CREDIT_COSTS has an entry and
 * nothing else does (credit-costs-coverage.test.ts), so a new key appears in the panel the moment it
 * is added to the table — the panel renders this list; it has no list of its own.
 */
export const CREDIT_COST_INFO: Record<string, { label: string; group: CreditGroup; unit?: string }> = {
  write_chapter: { label: 'Write / rewrite chapter', group: 'Writing' },
  write_short_story: { label: 'Write short story', group: 'Writing' },
  write_blog: { label: 'Write blog post (from a chapter)', group: 'Writing' },
  write_blog_post: { label: 'Write blog post', group: 'Writing' },
  write_newsletter: { label: 'Write newsletter', group: 'Writing' },
  brainstorm: { label: 'Brainstorm (short story)', group: 'Brainstorm & outline' },
  brainstorm_story: { label: 'Brainstorm a book (screen or chat)', group: 'Brainstorm & outline' },
  brainstorm_chapter: { label: 'Plan a chapter', group: 'Brainstorm & outline' },
  revise_outline: { label: 'Revise / edit outline', group: 'Brainstorm & outline' },
  research: { label: 'Research report', group: 'Research' },
  qa_chapter: { label: 'Q/A consistency check', group: 'Editing & QA' },
  repair_chapter: { label: 'Repair chapter (fix drift, fix Q/A, rewrite with research)', group: 'Editing & QA' },
  humanize_passage: { label: 'Humanize a passage', group: 'Editing & QA', unit: 'per 100 words' },
  promo_copy: { label: 'Promotion copy assistant (draft or revise a field)', group: 'Writing', unit: 'per field' },
  review_chapter: { label: 'Review chapter', group: 'Editing & QA' },
  cover_art: { label: 'Cover art', group: 'Media & social' },
  generate_cover_art: { label: 'Cover art (n8n name)', group: 'Media & social' },
  social_repurpose: { label: 'Social posts / drafts', group: 'Media & social', unit: 'per topic or draft' },
  repurpose_to_social_posts: { label: 'Social posts (n8n name)', group: 'Media & social' },
  chat_generic: { label: 'Chat: plain answer', group: 'Free operations' },
  list_outlines: { label: 'List outlines', group: 'Free operations' },
  retrieve_content: { label: 'Retrieve content', group: 'Free operations' },
  approve_content: { label: 'Approve content', group: 'Free operations' },
  list_story_arcs: { label: 'List story arcs', group: 'Free operations' },
  story_bible_edit: { label: 'Story bible edit', group: 'Free operations' },
  list_content: { label: 'List content', group: 'Free operations' },
  outline_versions: { label: 'Outline versions', group: 'Free operations' },
  revert_outline: { label: 'Revert outline', group: 'Free operations' },
  content_action: { label: 'Content state change', group: 'Free operations' },
  create_project: { label: 'Create project', group: 'Free operations' },
  scrape_url: { label: 'Scrape a URL', group: 'Free operations' },
  format_kindle: { label: 'Kindle export', group: 'Free operations' },
  email_content: { label: 'Email content', group: 'Free operations' },
  eve_callback: { label: 'Eve callback', group: 'Free operations' },
};

/** The panel's catalog: every key, its default, label, group and unit. */
export function creditCostCatalog(): Array<{ key: string; default: number; label: string; group: CreditGroup; unit?: string }> {
  return Object.entries(DEFAULT_CREDIT_COSTS).map(([key, def]) => ({
    key,
    default: def,
    label: CREDIT_COST_INFO[key]?.label ?? key,
    group: CREDIT_COST_INFO[key]?.group ?? 'Free operations',
    ...(CREDIT_COST_INFO[key]?.unit ? { unit: CREDIT_COST_INFO[key].unit } : {}),
  }));
}

/** The credit key an operation name is charged under, or null when it has no entry at all. */
export function resolveCreditKey(op: string): string | null {
  if (Object.prototype.hasOwnProperty.call(DEFAULT_CREDIT_COSTS, op)) return op;
  const alias = CREDIT_KEY_ALIASES[op];
  return alias && Object.prototype.hasOwnProperty.call(DEFAULT_CREDIT_COSTS, alias) ? alias : null;
}

const warnedUnmapped = new Set<string>();

let cachedCosts: Record<string, number> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

const SUPERUSER_CONFIG_KEY = 'sprint8_superuser_config';

async function loadCosts(): Promise<Record<string, number>> {
  if (cachedCosts && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cachedCosts;
  try {
    // Item 8: system-wide, so it lives in the global settings table (migration 045), not per-user.
    const configured = (await getGlobalJson<{ credit_costs?: Record<string, number> }>(SUPERUSER_CONFIG_KEY))?.credit_costs;
    cachedCosts = { ...DEFAULT_CREDIT_COSTS, ...(configured ?? {}) };
  } catch {
    cachedCosts = { ...DEFAULT_CREDIT_COSTS };
  }
  cacheLoadedAt = Date.now();
  return cachedCosts;
}

export async function getCreditCost(jobType: string): Promise<number> {
  const costs = await loadCosts();
  // A superuser-configured key (even one with no default) is honoured as-is.
  if (Object.prototype.hasOwnProperty.call(costs, jobType)) return costs[jobType];
  const key = resolveCreditKey(jobType);
  if (key !== null) return costs[key] ?? DEFAULT_CREDIT_COSTS[key];
  // Still 0 (never block a user on a naming slip), but loudly: an unmapped name is a billing gap.
  if (!warnedUnmapped.has(jobType)) {
    warnedUnmapped.add(jobType);
    logger.warn({ jobType }, 'credit-costs: operation has no credit entry; charging 0. Add it to DEFAULT_CREDIT_COSTS or CREDIT_KEY_ALIASES.');
  }
  return 0;
}

/** Every key's effective price (defaults overlaid with the superuser's overrides). */
export async function getAllCreditCosts(): Promise<Record<string, number>> {
  return { ...(await loadCosts()) };
}

export function clearCreditCostCache(): void {
  cachedCosts = null;
  cacheLoadedAt = 0;
  warnedUnmapped.clear();
}
