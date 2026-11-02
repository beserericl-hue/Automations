// Sprint 8 (S8-6 / S8-7): credit cost lookup, configurable via
// app_config_global_v2.sprint8_superuser_config.credit_costs. Falls back to
// hard-coded defaults when no config row exists.
//
// Defaults match the spec ("Writing operations: 5 credits, Brainstorm: 3,
// Research: 2, Cover art: 10, Social repurpose: 3, list/retrieve: 0").

import { getGlobalJson } from '../lib/app-config.js';

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
};

let cachedCosts: Record<string, number> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

const SUPERUSER_CONFIG_KEY = 'sprint8_superuser_config';

async function loadCosts(): Promise<Record<string, number>> {
  if (cachedCosts && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cachedCosts;
  try {
    // Item 8: system-wide, so it lives in the global settings table (migration 044), not per-user.
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
  return costs[jobType] ?? 0;
}

export function clearCreditCostCache(): void {
  cachedCosts = null;
  cacheLoadedAt = 0;
}
