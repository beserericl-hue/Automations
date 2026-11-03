/**
 * Credit-key coverage: every operation name the chat classifier, the engine hub catalog or a
 * charging route can emit must resolve to an EXPLICIT entry in the credit table (an explicit 0
 * counts). A name that misses the table is charged 0 silently — that is how chat research, social,
 * outline edits, QA and Kindle went unbilled while the same work on its own screen was charged.
 *
 * The engine catalog is read from engine/.../hub/catalog.py itself, so a new engine op fails here
 * until it is given a credit entry.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/app-config.js', () => ({ getGlobalJson: async () => null }));
const warn = vi.fn();
vi.mock('../lib/logger.js', () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  CREDIT_KEY_ALIASES,
  DEFAULT_CREDIT_COSTS,
  clearCreditCostCache,
  getCreditCost,
  resolveCreditKey,
} from '../services/credit-costs.js';
import { CLASSIFIER_DEFAULT_JOB_TYPE, CLASSIFIER_RULES } from '../lib/jobs/classifier.js';

const here = dirname(fileURLToPath(import.meta.url));
const WW = join(here, '..', '..', '..'); // writers-workbench/
const CATALOG = join(WW, 'engine', 'packages', 'writer_engine', 'src', 'writer_engine', 'hub', 'catalog.py');
const ROUTES = join(WW, 'server', 'src', 'routes');

function engineCatalogNames(): string[] {
  const src = readFileSync(CATALOG, 'utf8');
  const names = [...src.matchAll(/ToolSpec\(\s*"([a-z_]+)",\s*"([a-z-]+)",/g)].map((m) => `${m[1]}.${m[2]}`);
  return names;
}

/** Literal credit keys the charging routes pass to getCreditCost (directly or via a jobType const). */
function routeCreditKeys(): string[] {
  const keys = new Set<string>();
  for (const f of readdirSync(ROUTES).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES, f), 'utf8');
    if (!src.includes('getCreditCost')) continue;
    for (const m of src.matchAll(/getCreditCost\('([a-z_]+)'\)/g)) keys.add(m[1]);
    for (const m of src.matchAll(/const jobType = '([a-z_]+)'/g)) keys.add(m[1]);
    const table = src.match(/const JOB_TYPE[^=]*=\s*\{([\s\S]*?)\};/);
    if (table) for (const m of table[1].matchAll(/:\s*'([a-z_]+)'/g)) keys.add(m[1]);
  }
  return [...keys];
}

const classifierNames = [...new Set([...CLASSIFIER_RULES.map((r) => r.jobType), CLASSIFIER_DEFAULT_JOB_TYPE])];

describe('credit keys: every emitted operation has an explicit entry', () => {
  beforeEach(() => {
    clearCreditCostCache();
    warn.mockClear();
  });

  it('reads a non-trivial engine catalog (guards the parser)', () => {
    const names = engineCatalogNames();
    expect(names.length).toBeGreaterThanOrEqual(25);
    expect(names).toContain('research.run');
    expect(names).toContain('brainstorm.edit-outline');
  });

  it.each(classifierNames)('classifier jobType %s resolves to a credit entry', (op) => {
    expect(resolveCreditKey(op), `${op} has no credit entry — add it to DEFAULT_CREDIT_COSTS or CREDIT_KEY_ALIASES`).not.toBeNull();
  });

  it.each(engineCatalogNames())('engine catalog op %s resolves to a credit entry', (op) => {
    expect(resolveCreditKey(op), `${op} has no credit entry — add it to CREDIT_KEY_ALIASES`).not.toBeNull();
  });

  it.each(routeCreditKeys())('route credit key %s is a table entry', (key) => {
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_CREDIT_COSTS, key)).toBe(true);
  });

  it('aliases never shadow a key and always point at a key', () => {
    for (const [alias, key] of Object.entries(CREDIT_KEY_ALIASES)) {
      expect(DEFAULT_CREDIT_COSTS, `alias ${alias} is also a key`).not.toHaveProperty(alias);
      expect(DEFAULT_CREDIT_COSTS, `alias ${alias} -> missing key ${key}`).toHaveProperty(key);
    }
  });

  it('no emitted name hits the unmapped path (no warning, explicit cost)', async () => {
    for (const op of [...classifierNames, ...engineCatalogNames()]) await getCreditCost(op);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('credit keys: chat names cost the same as the equivalent screen operation', () => {
  beforeEach(() => clearCreditCostCache());

  it.each([
    ['research_report', 'research', 2],
    ['repurpose_social', 'social_repurpose', 3],
    ['edit_outline', 'revise_outline', 3],
    ['research.run', 'research', 2],
    ['media.social-posts', 'social_repurpose', 3],
    ['brainstorm.revise-outline', 'revise_outline', 3],
    ['chapter.write', 'write_chapter', 5],
    ['chapter.plan', 'brainstorm_chapter', 3],
    ['media.cover-art', 'cover_art', 10],
  ])('%s costs the same as %s (%i)', async (chatName, key, amount) => {
    expect(await getCreditCost(chatName)).toBe(await getCreditCost(key));
    expect(await getCreditCost(chatName)).toBe(amount);
  });

  it('pending-pricing ops stay an explicit 0 (not newly charged)', async () => {
    for (const op of ['qa_chapter', 'format_kindle', 'chapter.qa', 'chapter.repair', 'chapter.review', 'notify.eve-callback']) {
      expect(resolveCreditKey(op)).not.toBeNull();
      expect(await getCreditCost(op)).toBe(0);
    }
  });

  it('an unknown name still costs 0 but logs a warning (once)', async () => {
    warn.mockClear();
    expect(await getCreditCost('made_up_op')).toBe(0);
    expect(await getCreditCost('made_up_op')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ jobType: 'made_up_op' });
  });
});
