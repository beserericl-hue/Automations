#!/usr/bin/env python3
"""
Sprint 12 S12-11: create DEV - Tool - Evaluate Genre Compliance.

Storytelling craft evaluator. Reads a chapter, scores it against the
project's genre writing directive (genre_config_v2.writing_guidelines),
surfaces specific evidence and concrete suggestions, and persists the
result to chapter.metadata.genre_eval.

THREE-STREAM OUTPUT (architectural commitment from S12-11 design):

  prose_adaptations[]    — HOW changes within the existing outline.
                           Pipe to rewrite_chapter_with_research.
  outline_adaptations[]  — WHAT changes the outline needs for the
                           genre to work. NEVER auto-applied; user
                           explicitly approves each one through
                           edit_outline / brainstorm_chapter.
  observations[]         — Genre gaps with no clear adaptation path.
                           Informational only.

VALIDATION (S12-11.9): every persisted prose_adaptation must pass:
  1. adaptation_target ∈ ALLOWED_PROSE_TARGETS enum
  2. scope.sub_chapter ∈ {actual sub-chapter titles from outline}
  3. evidence.quote is a verbatim substring of chapter.content_text
     (catches Claude fabricating chapter prose)
  4. preserves.characters ⊆ outline character roster
  5. preserves.sub_chapter_title === scope.sub_chapter
  6. proposed_change.length >= 80 (no "make it more X" stubs)

Anything failing validation lands in metadata.genre_eval._rejected[]
with reason. Surfaces in admin UI later for prompt tuning.

OUTLINE LOCK: prose_adaptations cannot touch plot, characters, or
structure. Outline-change suggestions go in outline_adaptations[]
with requires_outline_change=true and a pipe_to_tool target.

V1 scope: uses writing_guidelines verbatim as the genre directive
(already cites exemplars + prescribes craft rules). No per-exemplar
research fan-out yet — layer that in v2 if eval output lacks
specificity.

Inputs:
  user_id, project_title, chapter_number

Output:
  genre_eval persisted to chapter.metadata.genre_eval +
  shape_output returns { overall_status, overall_score,
  prose_adaptation_count, outline_adaptation_count, observation_count,
  rejected_count, chapter_id }

Usage:
  N8N_API_KEY=...
  DEV_SUPABASE_SERVICE_ROLE_KEY=...
  ANTHROPIC_CRED_ID=5LhCYKsaFO3fF7II
  python3 scripts/s12-11-create-genre-eval-tool.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
WORKFLOW_NAME = "DEV - Tool - Evaluate Genre Compliance"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

DEV_SUPABASE_URL = "https://gvbvwcnmjkdpclcisqrr.supabase.co"


def api(method: str, path: str, body: Any | None = None) -> Any:
    key = os.environ.get("N8N_API_KEY")
    if not key:
        print("N8N_API_KEY not set", file=sys.stderr)
        sys.exit(2)
    req = Request(
        f"{N8N_BASE}/api/v1{path}",
        method=method,
        headers={
            "X-N8N-API-KEY": key,
            "User-Agent": UA,
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:500]}", file=sys.stderr)
        raise


def clean_put_body(wf: dict) -> dict:
    keep = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"]}
    if "settings" in wf:
        keep["settings"] = wf["settings"]
    for n in keep["nodes"]:
        if "disabled" in n and not isinstance(n["disabled"], bool):
            n.pop("disabled")
    return keep


def find_existing_by_name(name: str) -> str | None:
    cursor = None
    while True:
        path = "/workflows?limit=250"
        if cursor:
            path += "&cursor=" + cursor
        resp = api("GET", path)
        for wf in resp.get("data", []):
            if wf.get("name") == name:
                return wf["id"]
        cursor = resp.get("nextCursor")
        if not cursor:
            return None


# --------------------------------------------------------------------
# Code node bodies

LOAD_CONTEXT_CODE = r"""// S12-11 — load chapter, project, genre directive, sub-chapter map.

const trig = $('workflow_trigger').first().json;
const userId = (trig.user_id || '').toString();
const projectTitle = (trig.project_title || '').toString();
const chapterRaw = trig.chapter_number;

if (!userId) throw new Error('S12-11: user_id is required');
if (!projectTitle) throw new Error('S12-11: project_title is required');
if (chapterRaw == null || chapterRaw === '') throw new Error('S12-11: chapter_number is required');

function chapterLabel(v) {
  const s = v.toString().toLowerCase();
  if (s === 'prologue' || s === '0') return 'Prologue';
  if (s === 'epilogue') return 'Epilogue';
  return 'Chapter ' + v;
}
function parseChapter(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = v.toString().toLowerCase();
  if (s === 'prologue' || s === '0') return 0;
  if (s === 'epilogue') return 999;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
const chapterNum = parseChapter(chapterRaw);

const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = { apikey: apiKey, Authorization: 'Bearer ' + apiKey };

// 1. Resolve project (id + genre + outline + project_type).
const projUrl =
  supabaseUrl +
  '/rest/v1/writing_projects_v2?title=eq.' +
  encodeURIComponent(projectTitle) +
  '&user_id=eq.' +
  encodeURIComponent(userId) +
  '&select=id,genre_slug,project_type,outline&limit=1';
const projResp = await this.helpers.httpRequest({ method: 'GET', url: projUrl, headers });
const project = Array.isArray(projResp) ? projResp[0] : projResp;
if (!project || !project.id) {
  throw new Error('S12-11: project not found for user=' + userId + ' title=' + projectTitle);
}

// 2. Load chapter prose.
const chUrl =
  supabaseUrl +
  '/rest/v1/published_content_v2?project_id=eq.' +
  encodeURIComponent(project.id) +
  '&content_type=eq.chapter&chapter_number=eq.' +
  encodeURIComponent(chapterRaw.toString()) +
  '&deleted_at=is.null&select=id,title,content_text,metadata&limit=1';
const chResp = await this.helpers.httpRequest({ method: 'GET', url: chUrl, headers });
const chapter = Array.isArray(chResp) ? chResp[0] : chResp;
if (!chapter || !chapter.id) {
  throw new Error('S12-11: chapter ' + chapterRaw + ' not found in project ' + projectTitle);
}
const chapterText = chapter.content_text || '';
if (chapterText.length < 100) {
  throw new Error('S12-11: chapter prose is empty or too short to evaluate');
}

// 3. Load genre directive.
let genreDirective = null;
let genreName = null;
if (project.genre_slug) {
  const gUrl =
    supabaseUrl +
    '/rest/v1/genre_config_v2?genre_slug=eq.' +
    encodeURIComponent(project.genre_slug) +
    '&select=genre_name,description,writing_guidelines&limit=1';
  const gResp = await this.helpers.httpRequest({ method: 'GET', url: gUrl, headers });
  const gRow = Array.isArray(gResp) ? gResp[0] : gResp;
  if (gRow) {
    genreName = gRow.genre_name || project.genre_slug;
    genreDirective = (gRow.description || '') + '\n\n' + (gRow.writing_guidelines || '');
  }
}
if (!genreDirective || genreDirective.trim().length < 100) {
  throw new Error('S12-11: no usable writing_guidelines for genre ' + project.genre_slug);
}

// 4. Extract target chapter from outline (for sub-chapter map + character roster).
const outline = project.outline || {};
let targetCh = null;
if (Array.isArray(outline.chapters)) {
  if (chapterNum === 0) targetCh = outline.chapters[0];
  else if (chapterNum === 999) targetCh = outline.chapters[outline.chapters.length - 1];
  else targetCh = outline.chapters.find((c) => c.number === chapterNum) || null;
}

const subChapters = (targetCh && targetCh.chapter_outline && Array.isArray(targetCh.chapter_outline.sub_chapters))
  ? targetCh.chapter_outline.sub_chapters
  : [];
const subChapterTitles = subChapters.map((s) => s.title || '').filter(Boolean);

const characterRoster = (Array.isArray(outline.characters) ? outline.characters : [])
  .map((c) => c.name)
  .filter(Boolean);

const arcBeat =
  (targetCh && targetCh.chapter_outline && targetCh.chapter_outline.book_arc_beat) || null;
const chapterStoryArc =
  (targetCh && targetCh.chapter_outline && targetCh.chapter_outline.chapter_story_arc) || null;

return [
  {
    json: {
      user_id: userId,
      project_title: projectTitle,
      chapter_raw: chapterRaw,
      chapter_label: chapterLabel(chapterRaw),
      chapter_id: chapter.id,
      chapter_title: chapter.title,
      chapter_text: chapterText,
      chapter_word_count: (chapter.metadata && chapter.metadata.word_count) || chapterText.split(/\s+/).filter(Boolean).length,
      chapter_metadata: chapter.metadata || {},
      project: {
        id: project.id,
        genre_slug: project.genre_slug,
        project_type: project.project_type || 'fiction',
      },
      genre: {
        slug: project.genre_slug,
        name: genreName,
        directive: genreDirective,
      },
      outline: {
        sub_chapter_titles: subChapterTitles,
        sub_chapters: subChapters,
        character_roster: characterRoster,
        arc_beat: arcBeat,
        chapter_story_arc: chapterStoryArc,
        target_chapter: targetCh,
      },
    },
  },
];
"""

BUILD_EVAL_PROMPT_CODE = r"""// S12-11 — assemble the eval prompt.
// Bounded authority: outline-locked prose suggestions OR explicit
// outline-change suggestions in a separate stream. No blending.

const ctx = $input.first().json;

const subList = ctx.outline.sub_chapter_titles.length
  ? ctx.outline.sub_chapter_titles.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
  : '  _(no sub-chapter outline — chapter is a single scene)_';

const charList = ctx.outline.character_roster.length
  ? ctx.outline.character_roster.join(', ')
  : '_(no character roster)_';

const subChapterDetail = ctx.outline.sub_chapters.length
  ? ctx.outline.sub_chapters.map((s) =>
      `${s.number || '?'}. ${s.title}: ${s.brief || ''}`
    ).join('\n')
  : '';

const systemPrompt =
  'You are an experienced developmental editor evaluating a chapter against a genre writing directive.\n\n' +

  '# YOUR VOICE\n' +
  'Write like a working novel editor with twenty years in the chair — think Anne Lamott\n' +
  'marginalia, George Saunders teaching a workshop. Direct, warm, specific, opinionated.\n' +
  'You speak to the writer like a friend who has read two hundred novels in this register.\n' +
  '\n' +
  'AVOID corporate / LLM register. Do NOT say "This passage demonstrates", "The author\n' +
  'effectively uses", "This sentence successfully", "The text exhibits", "Consider\n' +
  'incorporating", "This could be enhanced by". Those phrasings are dead.\n' +
  '\n' +
  'PREFER: short declarative sentences. Direct address ("you" the writer). Concrete\n' +
  'observations about cadence, word choice, the specific moment a sentence loses its\n' +
  'nerve. The voice of someone who actually writes for a living.\n' +
  '\n' +
  'EXAMPLES of good editor voice:\n' +
  '  - "Cut this. The image already does the work — naming the nausea waters it down."\n' +
  '  - "You earned this in the previous paragraph. Trust it. Move on."\n' +
  '  - "This sentence ends one beat too late. End at \'institutional care.\' Let the\n' +
  '     reader hear the joke instead of explaining it to them."\n' +
  '  - "Craig\'s sincerity is doing all your work here. Don\'t undercut him with Mason\'s\n' +
  '     internal commentary — the reader can see what Craig can\'t."\n\n' +

  '# YOUR ROLE\n' +
  'You produce a structured assessment with three explicitly-typed streams:\n' +
  '  - prose_adaptations[]    : HOW the chapter is told. Bounded authority — see below.\n' +
  '  - outline_adaptations[]  : WHAT the outline needs to change for the genre to work.\n' +
  '  - observations[]         : Genre gaps with no clear adaptation path.\n\n' +

  '# WHAT YOU CAN AND CANNOT SUGGEST IN prose_adaptations\n' +
  'The OUTLINE is the WHAT — plot, characters, sub-chapter structure, arc beats.\n' +
  'For prose_adaptations[], the outline is FROZEN. Suggestions adapt the HOW within\n' +
  'the structure the outline already defines.\n\n' +

  'YOU MAY suggest changes (in prose_adaptations) to:\n' +
  '  - tonal_register (parodic / deadpan / gallows / sincere / etc.)\n' +
  '  - dialogue_rhythm (cadence and structure of spoken lines)\n' +
  '  - sentence_cadence (length, rhythm, punctuation patterns)\n' +
  '  - observational_distance (close-third / removed / intimate / clinical)\n' +
  '  - sensory_density (selection and density of sensory detail)\n' +
  '  - paragraph_pacing (paragraph length, break placement, white space)\n' +
  '  - voice_register (formal / colloquial / clinical / lyrical)\n' +
  '  - word_choice (specific vocabulary or phrasing within an existing line)\n\n' +

  'YOU MAY NOT suggest (in prose_adaptations) any of:\n' +
  '  - adding, removing, or reordering sub-chapters\n' +
  '  - adding, removing, renaming, aging, or re-roling characters\n' +
  '  - adding or removing scenes\n' +
  '  - changing plot events\n' +
  '  - changing what a sub-chapter is ABOUT (only how it READS)\n' +
  '  - changing the chapter\'s assigned story arc beat\n\n' +

  '# WHEN GENRE COMPLIANCE REQUIRES OUTLINE CHANGES\n' +
  'If executing a genre exemplar\'s technique would require an outline change\n' +
  '(e.g. "JoJo Rabbit\'s innocence frame requires a child narrator, but this\n' +
  'outline has a 30-year-old narrator"), output an outline_adaptation entry:\n' +
  '  {\n' +
  '    target: \'character_age\' | \'character_addition\' | \'character_removal\' |\n' +
  '            \'character_role\' | \'sub_chapter_addition\' | \'sub_chapter_removal\' |\n' +
  '            \'sub_chapter_reorder\' | \'arc_beat\' | \'scene\' | \'theme\' | \'setting\' |\n' +
  '            \'narrative_pov\',\n' +
  '    scope: { chapter_number: <int>, sub_chapter: <title or null> },\n' +
  '    current_state: <what the outline currently says>,\n' +
  '    proposed_state: <what would unlock the genre technique>,\n' +
  '    exemplar_grounding: { title: <named exemplar from the directive>, technique: <why this requires the change> },\n' +
  '    impact_radius: { other_chapters_affected: [<int>...], severity: \'high\'|\'medium\'|\'low\' },\n' +
  '    reversibility: \'low\'|\'medium\'|\'high\',\n' +
  '    pipe_to_tool: \'edit_outline\' | \'brainstorm_chapter\' | \'brainstorm_story\'\n' +
  '  }\n\n' +
  'NEVER auto-apply outline changes. Outline_adaptations are surfaced to the user as proposals.\n\n' +

  '# REQUIRED SHAPE FOR EACH prose_adaptation\n' +
  '  {\n' +
  '    rule_dimension: <name of genre rule from directive>,\n' +
  '    score: 0-100,\n' +
  '    status: \'PASS\'|\'NEEDS_WORK\'|\'FAIL\',\n' +
  '    adaptation_target: <one of the enum above>,\n' +
  '    scope: { sub_chapter: <EXACT title from outline> },\n' +
  '    evidence: {\n' +
  '      quote: <30-200 char VERBATIM copy-paste from the chapter — the single sentence or short passage that exemplifies the rule_dimension. Must be character-for-character findable in the chapter prose. The validator will compute the surrounding context block (the writer-facing "before" view) from this quote\'s position automatically.>,\n' +
  '      context_radius_chars: <integer 50-300, optional, default 150 — how many chars of chapter context to include around the quote when displaying to the writer>\n' +
  '    },\n' +
  '    exemplar: { title: <named exemplar from genre directive>, technique: <named technique> },\n' +
  '    after: <the actual rewritten prose, ready to paste into the chapter, replacing the chapter region around evidence.quote. For PASS suggestions where nothing changes, set after === evidence.quote (i.e. write the same quote unchanged). For NEEDS_WORK / FAIL, write what the prose should become — the rewritten sentence(s) themselves, not a directive about rewriting. The writer should be able to copy this directly.>,\n' +
  '    editor_note: <60-280 char prose comment in human-editor voice. Speak to the writer directly. Be specific about cadence, word choice, what works, what loses its nerve. Avoid LLM register. See voice examples above.>,\n' +
  '    proposed_change: <80+ char editorial directive — what to do and why it matters. Different from after (which is the prose); proposed_change is the editorial instruction.>,\n' +
  '    preserves: {\n' +
  '      plot_event: <the underlying scene event that stays unchanged>,\n' +
  '      characters: [<character names from outline roster>],\n' +
  '      sub_chapter_title: <same as scope.sub_chapter>,\n' +
  '      arc_beat: <chapter\'s arc beat>\n' +
  '    },\n' +
  '    requires_outline_change: false\n' +
  '  }\n\n' +

  '# OUTPUT BUDGET — STAY BOUNDED\n' +
  'Limit prose_adaptations to your TOP 8-10 most-impactful items, ranked by\n' +
  'how much they would improve genre compliance if applied. Quality over\n' +
  'quantity. Twelve mediocre suggestions are worse than seven sharp ones.\n' +
  'Cap evidence.quote and after at ~250 chars each. Cap editor_note at ~200 chars.\n' +
  'Your total response should fit comfortably under 12,000 tokens.\n\n' +

  '# THE ONE THING THAT MUST BE VERBATIM: evidence.quote\n' +
  'You provide a SHORT verbatim quote (30-200 chars) that demonstrates the rule_dimension.\n' +
  'The validator computes the surrounding context block from the chapter at the quote\'s\n' +
  'position. You do NOT need to copy out a longer prose block — that risks paraphrasing.\n' +
  'Stick to a tight, real quote. The system handles the context display.\n' +
  '\n' +
  'If you cannot point to a real verbatim passage in the chapter that demonstrates\n' +
  'the rule_dimension you want to address, output the rule as an observation\n' +
  'instead of a prose_adaptation. It is much better to surface 6 grounded suggestions\n' +
  'than 12 where half cite invented prose.\n\n' +

  '# REQUIRED SHAPE FOR observations[]\n' +
  '  {\n' +
  '    rule_dimension: <name of genre rule>,\n' +
  '    note: <what the chapter lacks>,\n' +
  '    why_no_actionable_suggestion: <e.g. "would require restructuring the entire book POV">\n' +
  '  }\n\n' +

  '# JSON QUOTING RULES — CRITICAL\n' +
  'When you quote prose from the chapter inside any JSON string value\n' +
  '(evidence.quote, after, proposed_change, editor_note, etc.), you MUST\n' +
  'handle the prose\'s own internal quotes correctly. Pick ONE:\n' +
  '  (a) Replace any internal double quotes (") in the quoted prose with\n' +
  '      single quotes (\') — this is the simplest and recommended path.\n' +
  '  (b) Escape internal double quotes with backslash: \\".\n' +
  'NEVER leave an unescaped " inside a string value. Example BAD:\n' +
  '    "evidence.quote": "Coffee?" Mason asks"            <- INVALID JSON\n' +
  'Example GOOD:\n' +
  '    "evidence.quote": "\'Coffee?\' Mason asks"           <- recommended\n' +
  '    "evidence.quote": "\\"Coffee?\\" Mason asks"         <- also valid\n' +
  '\n' +
  '# OUTPUT FORMAT — return ONLY valid parseable JSON, no markdown fences,\n' +
  '# no preamble, no commentary. The very first character of your response\n' +
  '# must be { and the very last character must be }.\n' +
  '{\n' +
  '  overall_score: 0-100,\n' +
  '  overall_status: \'PASS\'|\'NEEDS_WORK\'|\'FAIL\',\n' +
  '  summary: <2-3 sentence top-line read>,\n' +
  '  prose_adaptations: [...],\n' +
  '  outline_adaptations: [...],\n' +
  '  observations: [...]\n' +
  '}\n';

const userPrompt =
  '# GENRE DIRECTIVE FOR ' + (ctx.genre.name || ctx.genre.slug) + '\n\n' +
  ctx.genre.directive + '\n\n' +

  '---\n\n' +
  '# OUTLINE CONTEXT (the WHAT — frozen for prose_adaptations)\n\n' +
  '**Project:** ' + ctx.project_title + '\n' +
  '**Chapter:** ' + ctx.chapter_label + (ctx.chapter_title ? ' — ' + ctx.chapter_title : '') + '\n' +
  '**Character roster (use these names exactly):** ' + charList + '\n' +
  (ctx.outline.arc_beat ? '**Chapter arc beat:** ' + ctx.outline.arc_beat + '\n' : '') +
  (ctx.outline.chapter_story_arc ? '**Chapter story arc:** ' + ctx.outline.chapter_story_arc + '\n' : '') +
  '\n**Sub-chapter structure (any prose_adaptation must scope to one of these titles):**\n' + subList + '\n' +
  (subChapterDetail ? '\n**Sub-chapter briefs:**\n' + subChapterDetail + '\n' : '') +
  '\n---\n\n' +
  '# CHAPTER PROSE TO EVALUATE\n\n' +
  ctx.chapter_text + '\n';

return [{
  json: {
    ...ctx,
    eval_system_prompt: systemPrompt,
    eval_user_prompt: userPrompt,
  },
}];
"""

PARSE_AND_VALIDATE_CODE = r"""// S12-11.9 — parse Claude's JSON output, run all six validation
// checks, split into kept vs rejected.

const ctx = $('build_eval_prompt').first().json;
const llm = $input.first().json;
const raw = (llm.text || llm.output || llm.response || '').toString();

// Defensive parse:
//   1. Strip ```json ... ``` fences if Claude wrapped them despite instructions.
//   2. Try strict JSON.parse on the inner.
//   3. If that fails, try a single repair pass that escapes obvious
//      unescaped internal double quotes inside string values (the
//      "Coffee?" Mason asks pattern Claude produces sometimes).
//   4. If THAT still fails, surface UNKNOWN with a parse_error observation.
function tryRepairJson(s) {
  // Walk char by char: we are inside a JSON string when we see " preceded
  // by : or , (i.e. start of a value). The string ends at the next
  // unescaped " that is followed by , } ] or whitespace+one of those.
  // Any " inside that gets backslash-escaped.
  let out = '';
  let i = 0;
  let inString = false;
  while (i < s.length) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      i++;
      continue;
    }
    // inside a string
    if (c === '\\') {
      out += c + (s[i + 1] || '');
      i += 2;
      continue;
    }
    if (c === '"') {
      // peek ahead: is this the legit end of the string? Look for next
      // non-whitespace char being , } ] : (top-level structural).
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = s[j] || '';
      if (next === ',' || next === '}' || next === ']' || next === ':') {
        // legit close
        out += c;
        inString = false;
        i++;
        continue;
      }
      // otherwise it's an unescaped internal quote — escape it
      out += '\\"';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

let parsed;
let parseAttempts = [];
try {
  let inner = raw.trim();
  // Strip markdown fence
  const fence = inner.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  if (fence) inner = fence[1].trim();
  // First strict attempt
  try {
    parsed = JSON.parse(inner);
    parseAttempts.push('strict');
  } catch (e1) {
    // Repair attempt
    const repaired = tryRepairJson(inner);
    try {
      parsed = JSON.parse(repaired);
      parseAttempts.push('repaired');
    } catch (e2) {
      // Final fallback: extract first {...} block via greedy match
      const m = inner.match(/\{[\s\S]*\}/);
      if (m) {
        const repairedM = tryRepairJson(m[0]);
        parsed = JSON.parse(repairedM);
        parseAttempts.push('repaired_after_extract');
      } else {
        throw e2;
      }
    }
  }
} catch (e) {
  return [{
    json: {
      ...ctx,
      _parse_error: e.message,
      genre_eval: {
        generated_at: new Date().toISOString(),
        genre_slug: ctx.genre.slug,
        overall_status: 'UNKNOWN',
        overall_score: null,
        summary: 'Could not parse evaluator output as JSON',
        prose_adaptations: [],
        outline_adaptations: [],
        observations: [{
          rule_dimension: '_parse_error',
          note: 'JSON parse failed: ' + e.message,
          why_no_actionable_suggestion: 'eval pipeline error, retry',
        }],
        _rejected: [],
        _raw_first_500: raw.slice(0, 500),
      },
    },
  }];
}

// Fuzzy text-grounding (S12-11.9 option B). Normalize whitespace + common
// unicode punctuation drift on both sides before substring-matching. Catches
// the "Claude copied the prose but used a different em-dash / smart quote /
// trailing whitespace" class of false-rejection without opening the door to
// actual paraphrasing — the requirement is still that the words match, just
// not the exact bytes. Preserves the ORIGINAL prose in the persisted output.
function normalizeForMatch(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    // unicode quote variants -> straight ASCII
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    // em-dash, en-dash, minus, hyphen variants -> hyphen
    .replace(/[–—―−­]/g, '-')
    // ellipsis -> three dots
    .replace(/…/g, '...')
    // non-breaking spaces and other whitespace -> regular space
    .replace(/[       ]/g, ' ')
    // collapse all whitespace runs
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
// NORMALIZED_CHAPTER + chapterContains are declared AFTER chapterText below
// (avoids ReferenceError from const-hoisting since chapterText isn't
// initialized yet at this point in the file).

const ALLOWED_PROSE_TARGETS = new Set([
  'tonal_register',
  'dialogue_rhythm',
  'sentence_cadence',
  'observational_distance',
  'sensory_density',
  'paragraph_pacing',
  'voice_register',
  'word_choice',
]);

const ALLOWED_OUTLINE_TARGETS = new Set([
  'character_age',
  'character_addition',
  'character_removal',
  'character_role',
  'sub_chapter_addition',
  'sub_chapter_removal',
  'sub_chapter_reorder',
  'arc_beat',
  'scene',
  'theme',
  'setting',
  'narrative_pov',
]);

const subTitles = new Set(ctx.outline.sub_chapter_titles);
const charSet = new Set(ctx.outline.character_roster);
const chapterText = ctx.chapter_text || '';

// Now safe to compute the normalized chapter (chapterText is initialized).
const NORMALIZED_CHAPTER = normalizeForMatch(chapterText);
function chapterContains(snippet) {
  const norm = normalizeForMatch(snippet);
  if (!norm) return false;
  return NORMALIZED_CHAPTER.includes(norm);
}

// Heuristic generic-phrase blacklist (catches "make it more X" stubs).
const GENERIC_PREFIXES = [
  'make it ', 'be more ', 'add more ', 'use more ', 'try ', 'consider ',
  'maybe ', 'somewhat ', 'a bit ', 'slightly ',
];

function isGeneric(s) {
  const lc = (s || '').toLowerCase().trim();
  return GENERIC_PREFIXES.some((p) => lc.startsWith(p));
}

const kept_prose = [];
const kept_outline = [];
const rejected = [];

for (const s of (parsed.prose_adaptations || [])) {
  const drop = (reason) => rejected.push({ kind: 'prose_adaptation', reason, suggestion: s });

  if (!s || typeof s !== 'object') { drop('not_object'); continue; }
  if (!ALLOWED_PROSE_TARGETS.has(s.adaptation_target)) {
    drop('adaptation_target_not_in_enum: ' + s.adaptation_target);
    continue;
  }
  if (s.requires_outline_change === true) {
    drop('marked_requires_outline_change');
    continue;
  }
  if (!s.scope || !s.scope.sub_chapter) { drop('scope.sub_chapter_missing'); continue; }
  if (subTitles.size > 0 && !subTitles.has(s.scope.sub_chapter)) {
    drop('scope.sub_chapter_not_in_outline: ' + s.scope.sub_chapter);
    continue;
  }
  if (!s.evidence || !s.evidence.quote) { drop('evidence.quote_missing'); continue; }
  if (!chapterContains(s.evidence.quote)) {
    drop('evidence.quote_not_in_chapter (fabricated)');
    continue;
  }
  if (!s.preserves || !s.preserves.plot_event || !s.preserves.sub_chapter_title) {
    drop('preserves_incomplete');
    continue;
  }
  if (s.preserves.sub_chapter_title !== s.scope.sub_chapter) {
    drop('preserves.sub_chapter_title_mismatch');
    continue;
  }
  if (Array.isArray(s.preserves.characters)) {
    const bad = s.preserves.characters.filter((c) => charSet.size > 0 && !charSet.has(c));
    if (bad.length) {
      drop('preserves.characters_not_in_outline: ' + bad.join(','));
      continue;
    }
  }
  if (!s.proposed_change || s.proposed_change.length < 80) {
    drop('proposed_change_too_short');
    continue;
  }
  if (isGeneric(s.proposed_change)) {
    drop('proposed_change_too_generic');
    continue;
  }

  // after / editor_note checks. before is now COMPUTED, not declared.
  if (s.after == null || typeof s.after !== 'string') {
    drop('after_missing');
    continue;
  }
  if (s.status !== 'PASS' && s.after.trim() === s.evidence.quote.trim()) {
    drop('after_unchanged_for_non_pass');
    continue;
  }
  // Bound runaway expansion (after shouldn't be more than 4x evidence.quote)
  if (s.after.length > Math.max(500, s.evidence.quote.length * 4)) {
    drop('after_too_long_relative_to_quote');
    continue;
  }
  if (!s.editor_note || s.editor_note.length < 60) {
    drop('editor_note_missing_or_too_short');
    continue;
  }

  // Compute the `before` block from the actual chapter prose around the
  // verified evidence.quote position. This is the writer-facing context view.
  // Guarantees zero fabrication: every `before` we surface is real chapter
  // text by construction.
  const radiusRaw = (s.evidence && s.evidence.context_radius_chars) || 150;
  const radius = Math.max(50, Math.min(300, parseInt(radiusRaw, 10) || 150));
  // Find the quote position via fuzzy normalization, then map back to original chars.
  const normQuote = normalizeForMatch(s.evidence.quote);
  let normPos = NORMALIZED_CHAPTER.indexOf(normQuote);
  // Map normalized position back to original chapter position via best-effort search.
  // Simpler: search the original chapter for a window that normalizes to the same.
  let origPos = chapterText.indexOf(s.evidence.quote);
  if (origPos < 0) {
    // Fallback: scan original chapter in chunks to find one whose normalized form starts at normPos.
    for (let i = 0; i < chapterText.length - 10; i++) {
      const window = chapterText.substring(i, Math.min(chapterText.length, i + s.evidence.quote.length + 30));
      if (normalizeForMatch(window).startsWith(normQuote)) {
        origPos = i;
        break;
      }
    }
  }
  if (origPos < 0) {
    // Should not happen — chapterContains(quote) was true. Defensive only.
    drop('quote_position_lookup_failed');
    continue;
  }
  const beforeStart = Math.max(0, origPos - radius);
  const beforeEnd = Math.min(chapterText.length, origPos + s.evidence.quote.length + radius);
  s.before = chapterText.substring(beforeStart, beforeEnd);
  s._before_computed_from_chapter = true;
  s._before_position = { start: beforeStart, end: beforeEnd, quote_offset_in_before: origPos - beforeStart };

  kept_prose.push(s);
}

for (const o of (parsed.outline_adaptations || [])) {
  const drop = (reason) => rejected.push({ kind: 'outline_adaptation', reason, suggestion: o });
  if (!o || typeof o !== 'object') { drop('not_object'); continue; }
  if (!ALLOWED_OUTLINE_TARGETS.has(o.target)) {
    drop('target_not_in_enum: ' + o.target);
    continue;
  }
  if (!o.current_state || !o.proposed_state) { drop('state_missing'); continue; }
  if (!o.exemplar_grounding || !o.exemplar_grounding.title) { drop('exemplar_grounding_missing'); continue; }
  if (!['edit_outline', 'brainstorm_chapter', 'brainstorm_story'].includes(o.pipe_to_tool)) {
    drop('pipe_to_tool_invalid: ' + o.pipe_to_tool);
    continue;
  }
  kept_outline.push(o);
}

const observations = Array.isArray(parsed.observations) ? parsed.observations : [];

const overall_status = (parsed.overall_status || '').toUpperCase();
const validatedStatus = ['PASS', 'NEEDS_WORK', 'FAIL', 'UNKNOWN'].includes(overall_status)
  ? overall_status
  : 'UNKNOWN';

const genre_eval = {
  generated_at: new Date().toISOString(),
  genre_slug: ctx.genre.slug,
  genre_name: ctx.genre.name,
  overall_status: validatedStatus,
  overall_score: typeof parsed.overall_score === 'number' ? parsed.overall_score : null,
  summary: parsed.summary || '',
  prose_adaptations: kept_prose,
  outline_adaptations: kept_outline,
  observations,
  _rejected: rejected,
  _parse_attempts: parseAttempts,
  _stats: {
    prose_kept: kept_prose.length,
    outline_kept: kept_outline.length,
    observations: observations.length,
    rejected: rejected.length,
    rejected_by_reason: rejected.reduce((acc, r) => {
      const key = r.reason.split(':')[0];
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  },
};

return [{ json: { ...ctx, genre_eval } }];
"""

PERSIST_AND_RETURN_CODE = r"""// S12-11 — PATCH chapter.metadata.genre_eval and emit a summary.

const ctx = $input.first().json;
const ge = ctx.genre_eval;

const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = {
  apikey: apiKey,
  Authorization: 'Bearer ' + apiKey,
  'Content-Type': 'application/json',
};

try {
  // Fetch current metadata so we don't clobber other keys (last_rewrite, qa_report, etc).
  const cur = await this.helpers.httpRequest({
    method: 'GET',
    url: supabaseUrl + '/rest/v1/published_content_v2?id=eq.' + encodeURIComponent(ctx.chapter_id) + '&select=metadata',
    headers,
  });
  const curMeta = (Array.isArray(cur) && cur[0] && cur[0].metadata) ? cur[0].metadata : {};
  const newMeta = { ...curMeta, genre_eval: ge };
  await this.helpers.httpRequest({
    method: 'PATCH',
    url: supabaseUrl + '/rest/v1/published_content_v2?id=eq.' + encodeURIComponent(ctx.chapter_id),
    headers,
    body: JSON.stringify({ metadata: newMeta, updated_at: new Date().toISOString() }),
  });
} catch (e) {
  return [{ json: {
    error: 'persist_failed: ' + e.message,
    genre_eval: ge,
    chapter_id: ctx.chapter_id,
  } }];
}

return [{
  json: {
    chapter_id: ctx.chapter_id,
    chapter_label: ctx.chapter_label,
    overall_status: ge.overall_status,
    overall_score: ge.overall_score,
    summary: ge.summary,
    counts: ge._stats,
  },
}];
"""


def build_workflow_body() -> dict:
    supabase_key = os.environ["DEV_SUPABASE_SERVICE_ROLE_KEY"]
    anthropic_cred_id = os.environ["ANTHROPIC_CRED_ID"]

    nodes = [
        {
            "parameters": {
                "workflowInputs": {
                    "values": [
                        {"name": "user_id", "type": "string"},
                        {"name": "project_title", "type": "string"},
                        {"name": "chapter_number", "type": "string"},
                    ],
                },
            },
            "id": "trig",
            "name": "workflow_trigger",
            "type": "n8n-nodes-base.executeWorkflowTrigger",
            "typeVersion": 1.1,
            "position": [0, 0],
        },
        {
            "parameters": {
                "assignments": {
                    "assignments": [
                        {"id": "u", "name": "SUPABASE_URL", "value": DEV_SUPABASE_URL, "type": "string"},
                        {"id": "k", "name": "SUPABASE_API_KEY", "value": supabase_key, "type": "string"},
                    ],
                },
                "options": {},
            },
            "id": "set",
            "name": "settings",
            "type": "n8n-nodes-base.set",
            "typeVersion": 3.4,
            "position": [220, 0],
        },
        {
            "parameters": {"jsCode": LOAD_CONTEXT_CODE},
            "id": "load",
            "name": "load_context",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, 0],
        },
        {
            "parameters": {"jsCode": BUILD_EVAL_PROMPT_CODE},
            "id": "build",
            "name": "build_eval_prompt",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [660, 0],
        },
        {
            "parameters": {
                "promptType": "define",
                "text": "={{ $json.eval_system_prompt + '\\n\\n---\\n\\n' + $json.eval_user_prompt }}",
            },
            "id": "chain",
            "name": "eval_llm_chain",
            "type": "@n8n/n8n-nodes-langchain.chainLlm",
            "typeVersion": 1.7,
            "position": [880, 0],
        },
        {
            "parameters": {
                "model": {"__rl": True, "mode": "list", "value": "claude-sonnet-4-5"},
                "options": {"temperature": 0.3, "maxTokensToSample": 16000},
            },
            "id": "claude",
            "name": "eval_claude",
            "type": "@n8n/n8n-nodes-langchain.lmChatAnthropic",
            "typeVersion": 1.3,
            "position": [880, 200],
            "credentials": {
                "anthropicApi": {"id": anthropic_cred_id, "name": "Anthropic account"}
            },
        },
        {
            "parameters": {"jsCode": PARSE_AND_VALIDATE_CODE},
            "id": "parse",
            "name": "parse_and_validate",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1100, 0],
        },
        {
            "parameters": {"jsCode": PERSIST_AND_RETURN_CODE},
            "id": "persist",
            "name": "persist_and_return",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1320, 0],
        },
    ]

    connections = {
        "workflow_trigger": {"main": [[{"node": "settings", "type": "main", "index": 0}]]},
        "settings": {"main": [[{"node": "load_context", "type": "main", "index": 0}]]},
        "load_context": {"main": [[{"node": "build_eval_prompt", "type": "main", "index": 0}]]},
        "build_eval_prompt": {"main": [[{"node": "eval_llm_chain", "type": "main", "index": 0}]]},
        "eval_llm_chain": {"main": [[{"node": "parse_and_validate", "type": "main", "index": 0}]]},
        "eval_claude": {
            "ai_languageModel": [[{"node": "eval_llm_chain", "type": "ai_languageModel", "index": 0}]]
        },
        "parse_and_validate": {"main": [[{"node": "persist_and_return", "type": "main", "index": 0}]]},
    }

    return {
        "name": WORKFLOW_NAME,
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }


def main() -> int:
    for var in ("DEV_SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_CRED_ID"):
        if not os.environ.get(var):
            print(f"{var} not set", file=sys.stderr)
            return 2

    body = build_workflow_body()
    existing = find_existing_by_name(WORKFLOW_NAME)
    if existing:
        print(f"Updating existing workflow {existing}...")
        try:
            api("POST", f"/workflows/{existing}/deactivate")
        except HTTPError as e:
            print(f"  deactivate returned {e.code}, continuing with PUT")
        api("PUT", f"/workflows/{existing}", clean_put_body(body))
        try:
            api("POST", f"/workflows/{existing}/activate")
        except HTTPError as e:
            print(f"  activate returned {e.code}; may already be active")
        wf_id = existing
    else:
        print("Creating new workflow...")
        created = api("POST", "/workflows", body)
        wf_id = created["id"]
        api("POST", f"/workflows/{wf_id}/activate")

    print(f"{WORKFLOW_NAME}: {wf_id} (active)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
