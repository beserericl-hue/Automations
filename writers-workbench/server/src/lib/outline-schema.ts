/**
 * The one outline schema, enforced on every server-side write (item 7).
 *
 * Mirrors engine/packages/writer_engine/src/writer_engine/outline_schema.py exactly — the canonical
 * shape is the engine's (`chapter_number` + `beat`), the legacy n8n shape (`number` + `brief`) is
 * normalised on the way in, and anything else is rejected with every problem named. Both are tested
 * against writers-workbench/shared/outline-schema-cases.json, so they cannot drift.
 *
 * `_`-prefixed keys (`_marketing`, `_landing_page`, `_volume_plan` ...) are metadata owned by their
 * writers and pass through untouched.
 */
import { z } from 'zod';

const TOP_LEVEL_STRING_KEYS = ['title', 'premise', 'story_arc_name', 'dramatic_question', 'wow_factor', 'form'] as const;
export const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([...TOP_LEVEL_STRING_KEYS, 'themes', 'characters', 'chapters']);
const CHAPTER_STRING_KEYS = ['title', 'beat', 'act', 'arc_point', 'pov_character', 'bridge_from_prior', 'arc_notes', 'arc_notes_extended'] as const;
const CHAPTER_OBJECT_KEYS = ['chapter_outline', 'research', 'last_qa_report'] as const;
const CHAPTER_LIST_KEYS = ['research_topics'] as const;
const MAX_PROBLEMS = 20;

export type OutlineJson = Record<string, unknown>;

export class OutlineValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    const kept = problems.slice(0, MAX_PROBLEMS);
    const more = problems.length - kept.length;
    super(`Outline rejected: ${kept.join('; ')}${more > 0 ? `; and ${more} more` : ''}`);
    this.name = 'OutlineValidationError';
    this.problems = kept;
  }
}

// ------------------------------------------------------------------------------- canonical (zod)

const text = z.string().nullable().optional();

export const OutlineChapterSchema = z
  .object({
    chapter_number: z.number().int().min(0),
    title: z.string(),
    beat: z.string().optional(),
    act: text,
    arc_point: text,
    pov_character: text,
    bridge_from_prior: text,
    arc_notes: text,
    arc_notes_extended: text,
    chapter_outline: z.record(z.string(), z.unknown()).nullable().optional(),
    research: z.record(z.string(), z.unknown()).nullable().optional(),
    last_qa_report: z.record(z.string(), z.unknown()).nullable().optional(),
    research_topics: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

export const OutlineSchema = z
  .object({
    title: text,
    premise: text,
    story_arc_name: text,
    dramatic_question: text,
    wow_factor: text,
    form: text,
    themes: z.array(z.string()).optional(),
    characters: z.array(z.record(z.string(), z.unknown())).optional(),
    chapters: z.array(OutlineChapterSchema).optional(),
  })
  .passthrough();

// ------------------------------------------------------------------------------- normalisation

function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v; // string | number | boolean
}

function repr(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : JSON.stringify(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 4, 4.0 and "04" are chapter 4. true, 4.5, "four" and "" are not chapter numbers. */
function asInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

function asText(v: unknown, where: string, problems: string[]): unknown {
  if (v === null || v === undefined || typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  problems.push(`${where} must be text, got ${typeName(v)}`);
  return v;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function normalizeChapter(ch: unknown, i: number, problems: string[]): unknown {
  const where = `chapters[${i}]`;
  if (!isObject(ch)) {
    problems.push(`${where} must be an object, got ${typeName(ch)}`);
    return ch;
  }
  const hasCanonical = ch.chapter_number !== null && ch.chapter_number !== undefined;
  const raw = hasCanonical ? ch.chapter_number : ch.number;
  const number = asInt(raw);
  if (raw === null || raw === undefined) {
    problems.push(`${where} has no chapter number (expected 'chapter_number'; legacy 'number' is accepted)`);
  } else if (number === null || number < 0) {
    problems.push(`${where} chapter number ${repr(raw)} is not a whole number >= 0`);
  }
  if (hasCanonical && ch.number !== null && ch.number !== undefined && asInt(ch.number) !== number) {
    problems.push(`${where} has both chapter_number=${repr(ch.chapter_number)} and number=${repr(ch.number)}`);
  }
  const beatText = nonEmpty(ch.beat) ? ch.beat : null;
  const briefText = nonEmpty(ch.brief) ? ch.brief : null;
  if (beatText !== null && briefText !== null && beatText !== briefText) {
    problems.push(`${where} has both 'beat' and legacy 'brief' with different text; keep one`);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ch)) {
    if (key === 'number') {
      if (!hasCanonical) out.chapter_number = number ?? value;
    } else if (key === 'brief') {
      if (beatText === null) out.beat = value;
    } else if (key === 'beat') {
      if (beatText !== null || briefText === null) out.beat = value;
    } else if (key === 'chapter_number') {
      out[key] = number ?? value;
    } else {
      out[key] = value;
    }
  }
  for (const key of CHAPTER_STRING_KEYS) if (key in out) out[key] = asText(out[key], `${where}.${key}`, problems);
  if (!('title' in out)) out.title = '';
  for (const key of CHAPTER_OBJECT_KEYS) {
    if (key in out && out[key] !== null && !isObject(out[key])) problems.push(`${where}.${key} must be an object, got ${typeName(out[key])}`);
  }
  for (const key of CHAPTER_LIST_KEYS) {
    if (key in out && out[key] !== null && !Array.isArray(out[key])) problems.push(`${where}.${key} must be a list, got ${typeName(out[key])}`);
  }
  return out;
}

/** The outline in canonical form, or throws OutlineValidationError. Never mutates its argument. */
export function normalizeOutline(outline: unknown): OutlineJson {
  if (!isObject(outline)) throw new OutlineValidationError([`outline must be an object, got ${typeName(outline)}`]);
  const problems: string[] = [];
  const out: OutlineJson = {};
  const allowed = [...TOP_LEVEL_KEYS].sort().join(', ');
  for (const [key, value] of Object.entries(outline)) {
    if (key.startsWith('_')) {
      out[key] = value;
      continue;
    }
    if (!TOP_LEVEL_KEYS.has(key)) {
      problems.push(`unknown top-level key '${key}' (allowed: ${allowed}, or _metadata)`);
      continue;
    }
    if ((TOP_LEVEL_STRING_KEYS as readonly string[]).includes(key)) {
      out[key] = asText(value, key, problems);
    } else if (key === 'themes') {
      if (typeof value === 'string') out[key] = value.split(',').map((t) => t.trim()).filter(Boolean);
      else if (Array.isArray(value)) {
        out[key] = value.flatMap((t, j) => {
          if (typeof t === 'string') return [t];
          if (typeof t === 'number') return [String(t)];
          problems.push(`themes[${j}] must be text, got ${typeName(t)}`);
          return [];
        });
      } else if (value === null || value === undefined) out[key] = [];
      else problems.push(`themes must be a list of text, got ${typeName(value)}`);
    } else if (key === 'characters') {
      if (value === null || value === undefined) out[key] = [];
      else if (!Array.isArray(value)) problems.push(`characters must be a list, got ${typeName(value)}`);
      else {
        out[key] = value.flatMap((c, j) => {
          if (isObject(c)) return [c];
          if (nonEmpty(c)) return [{ name: c.trim() }];
          problems.push(`characters[${j}] must be an object, got ${typeName(c)}`);
          return [];
        });
      }
    } else if (key === 'chapters') {
      if (value === null || value === undefined) out[key] = [];
      else if (!Array.isArray(value)) problems.push(`chapters must be a list, got ${typeName(value)}`);
      else out[key] = value.map((ch, i) => normalizeChapter(ch, i, problems));
    }
  }

  const seen = new Map<number, number>();
  ((out.chapters as unknown[] | undefined) ?? []).forEach((ch, i) => {
    const n = isObject(ch) ? ch.chapter_number : undefined;
    if (typeof n === 'number' && Number.isInteger(n)) {
      if (seen.has(n)) problems.push(`chapters[${i}] repeats chapter number ${n} (also chapters[${seen.get(n)}])`);
      else seen.set(n, i);
    }
  });

  if (!problems.length) {
    const parsed = OutlineSchema.safeParse(out);
    if (!parsed.success) for (const issue of parsed.error.issues.slice(0, MAX_PROBLEMS)) problems.push(`${issue.path.join('.')}: ${issue.message}`);
  }
  if (problems.length) throw new OutlineValidationError(problems);
  return out;
}

/** The HTTP answer for a rejected outline: 422 with every problem listed. */
export function outlineErrorBody(err: OutlineValidationError) {
  return { success: false, error: { code: 'INVALID_OUTLINE', message: err.message, problems: err.problems } };
}
