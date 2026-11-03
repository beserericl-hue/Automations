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
  // Explicitly zero: not charged on ANY entry point today. Their price is a pending decision by the
  // owner — named here so they are a deliberate 0, not a lookup miss.
  qa_chapter: 0,
  repair_chapter: 0,
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
};

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

export function clearCreditCostCache(): void {
  cachedCosts = null;
  cacheLoadedAt = 0;
  warnedUnmapped.clear();
}
