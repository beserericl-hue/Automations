#!/usr/bin/env python3
"""
Sprint 12 S12-6: create DEV - Tool - Rewrite Chapter with Research.

Credibility-first chapter rewrite. Pulls an existing chapter, runs the
S12-7 research pipeline over a caller-supplied focus, then calls Claude
Sonnet with a prompt that grounds prose in the research WITHOUT
printing citations for fiction.

The tool's defining behavioural distinction:

  Fiction (default):     research grounds character arguments, historical
                         references, and technical vocabulary. No
                         footnote markers, no source labels in prose.
                         Citations live only in the saved research
                         report (audit trail).
  Non-fiction:           inline citations permitted in prose (default
                         when project.project_type='non_fiction').
  force_citations_in_prose (optional bool): hard override if the caller
                         knows better than the default inference.

Inputs:
  user_id                    — required
  project_title              — required
  chapter_number             — required
  research_focus             — required
  use_qa_report              — optional bool (default false) — if true
                               we also load the last QA report and
                               instruct the rewrite to address its
                               findings
  style_directives           — optional free-text steering (e.g.
                               "tighter prose, fewer adverbs")
  force_citations_in_prose   — optional bool

Output:
  rewritten_chapter   — markdown prose
  research_report_id  — UUID of the research report used
  citations_in_prose  — true/false, what mode was applied
  chars               — length of the rewrite
  version_id          — content_versions_v2 row id (if we saved one)

The rewrite is persisted as a content_versions_v2 row (history) and
updates published_content_v2.content with the new prose. Both are
existing tables; no schema changes.

Usage:
  N8N_API_KEY=...
  DEV_SUPABASE_SERVICE_ROLE_KEY=...
  ANTHROPIC_CRED_ID=5LhCYKsaFO3fF7II
  RESEARCH_PIPELINE_WF_ID=ACgIg1WPkIipiy5o
  python3 scripts/s12-6-create-rewrite-with-research.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
WORKFLOW_NAME = "DEV - Tool - Rewrite Chapter with Research"

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


def clean_workflow_put_body(wf: dict) -> dict:
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
# Code nodes

LOAD_CHAPTER_CODE = r"""// S12-6 — load the chapter prose and resolve project_type + prior QA.

const trig = $('workflow_trigger').first().json;
const userId = (trig.user_id || '').toString();

// Gemini tool-calling quirk: when the user's prompt quotes the
// project title (e.g. rewrite chapter 7 of "The Invisible Wall" ...),
// Gemini sometimes dumps everything after the opening quote into
// project_title. Sanitize aggressively: take the first line, trim
// trailing quotes/punctuation, strip anything following a bare
// double quote.
const rawTitle = (trig.project_title || '').toString();
const projectTitle = rawTitle
  .split(/\r?\n/)[0]
  .split('"')[0]
  .replace(/[.,;:\s"']+$/, '')
  .trim();

const chapterRaw = trig.chapter_number;
const focus = (trig.research_focus || '').toString().trim();
const useQa = !!trig.use_qa_report;
const styleDirectives = (trig.style_directives || '').toString().trim();

if (!userId) throw new Error('S12-6: user_id is required');
if (!projectTitle) throw new Error('S12-6: project_title is required');
if (chapterRaw == null || chapterRaw === '') throw new Error('S12-6: chapter_number is required');
if (!focus) throw new Error('S12-6: research_focus is required');

function chapterLabel(v) {
  const s = v.toString().toLowerCase();
  if (s === 'prologue' || s === '0') return 'Prologue';
  if (s === 'epilogue') return 'Epilogue';
  return 'Chapter ' + v;
}

const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = { apikey: apiKey, Authorization: 'Bearer ' + apiKey };

// 1. Resolve project (for id + project_type + genre).
const projUrl =
  supabaseUrl +
  '/rest/v1/writing_projects_v2?title=eq.' +
  encodeURIComponent(projectTitle) +
  '&user_id=eq.' +
  encodeURIComponent(userId) +
  '&select=id,genre_slug,project_type&limit=1';
const projResp = await this.helpers.httpRequest({ method: 'GET', url: projUrl, headers });
const project = Array.isArray(projResp) ? projResp[0] : projResp;
if (!project || !project.id) {
  throw new Error('S12-6: project not found for user=' + userId + ' title=' + projectTitle);
}

// 2. Load the chapter row.
// NOTE: published_content_v2 stores prose in `content_text`, not
// `content`. There is no top-level `summary` or `word_count`; those
// live in metadata when present.
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
  throw new Error('S12-6: chapter ' + chapterRaw + ' not found in project ' + projectTitle);
}
// Normalise so downstream code can read chapter.content as before.
chapter.content = chapter.content_text || '';

// 3. Decide citation mode.
const forceCites = trig.force_citations_in_prose;
let citationsInProse;
if (typeof forceCites === 'boolean') {
  citationsInProse = forceCites;
} else {
  citationsInProse = (project.project_type || 'fiction').toLowerCase() === 'non_fiction';
}

// 4. Optional last QA report.
let qaReport = null;
if (useQa) {
  const md = chapter.metadata || {};
  qaReport = md.last_qa_report || md.qa_report || null;
}

return [
  {
    json: {
      user_id: userId,
      project_title: projectTitle,
      chapter_raw: chapterRaw,
      chapter_label: chapterLabel(chapterRaw),
      focus,
      project,
      chapter,
      citations_in_prose: citationsInProse,
      style_directives: styleDirectives,
      qa_report: qaReport,
    },
  },
];
"""

BUILD_REWRITE_PROMPT_CODE = r"""// S12-6 — assemble the credibility-first rewrite prompt.
//
// HARD PRECEDENCE (top wins when they conflict):
//   1. Book outline + story arc + genre writing directive  (OUTLINE TRUTH)
//   2. Story bible entries for named characters/places      (OUTLINE TRUTH)
//   3. Previous chapter summaries                           (CONTINUITY TRUTH)
//   4. Original chapter prose + user focus statement        (WHAT TO REWRITE)
//   5. Research report                                      (REFERENCE ONLY)
//
// Research NEVER overrides outline facts. If the research suggests a
// detail (a name, a timeline, a procedure) that contradicts the
// outline or story bible, the outline wins. Research is reference
// material for plausibility — never the source of character identity,
// plot events, or structural decisions.

const loaded = $('load_chapter').first().json;
const research = $('call_research_pipeline').first().json;
const ctx = ($('build_chapter_context').first() || { json: {} }).json;

const researchContent = research.content || '';
const researchReportId = research.research_report_id || null;
const contextDoc = ctx.context_document || '';

const style = loaded.style_directives;
const qa = loaded.qa_report;
const chapter = loaded.chapter || {};
const chapterText = chapter.content || '';

const modeBlock = loaded.citations_in_prose
  ? (
      'CITATION MODE: INLINE.\n' +
      'This is non-fiction or the caller explicitly requested inline\n' +
      'citations. Embed source references in the prose using markdown\n' +
      'footnote syntax ([^1], [^2] ...). Keep one flat footnote list at\n' +
      'the end of the rewritten chapter. Every non-trivial factual\n' +
      'claim must carry a citation marker.'
    )
  : (
      'CITATION MODE: INVISIBLE (FICTION DEFAULT).\n' +
      'Do NOT print footnote markers, parenthetical citations, source\n' +
      'labels, or "according to ..." constructions in the prose. The\n' +
      'research report is research notes, not a bibliography to quote.\n' +
      'Use the facts in it to make character arguments, historical\n' +
      'references, vocabulary, and procedural descriptions credible —\n' +
      'but the prose reads like fiction, not like a footnoted essay.'
    );

const qaBlock = (qa && typeof qa === 'string' && qa.trim())
  ? '\n\nKNOWN ISSUES TO ADDRESS (from the last consistency review):\n' + qa.trim() + '\n'
  : '';

const styleBlock = style ? '\n\nSTYLE DIRECTIVES:\n' + style + '\n' : '';

const systemPrompt =
  'You are rewriting one chapter of a novel. Your job is to reconcile\n' +
  'the chapter with the BOOK OUTLINE + STORY BIBLE + STORY ARC + GENRE\n' +
  'WRITING DIRECTIVE and ground its factual content in the supplied\n' +
  'research. You are the author, not a critic.\n\n' +

  '# HARD PRECEDENCE — READ THIS FIRST\n' +
  'When sources conflict, this is the order of authority:\n' +
  '  1. BOOK OUTLINE (character roster, premise, chapter map)  — ABSOLUTE\n' +
  '  2. STORY BIBLE (named characters, places, rules)            — ABSOLUTE\n' +
  '  3. STORY ARC BEATS / GENRE WRITING DIRECTIVE                — ABSOLUTE\n' +
  '  4. PREVIOUS CHAPTERS (established continuity)               — ABSOLUTE\n' +
  '  5. Original chapter prose + focus statement                 — subject to correction\n' +
  '  6. Research report                                          — REFERENCE ONLY\n' +
  '\n' +
  'If the research suggests a name, age, relationship, location, or\n' +
  'event that contradicts layers 1–4, the research is WRONG for this\n' +
  'book. The outline wins. Every time.\n\n' +

  '# LOCKED CHARACTER IDENTITY\n' +
  'Every named character in the BOOK OUTLINE has a locked name_format\n' +
  'and biography. You MUST use those names exactly. NEVER introduce an\n' +
  'alternate surname, nickname, or ethnic variant (e.g. do not rename\n' +
  '"Lucia Morales" to "Lucia Moretti", "Santos-Martinez", or any other\n' +
  'form). Their age, family, relationships, and role in the plot come\n' +
  'from the outline — not from research, not from the original prose.\n' +
  '\n' +
  'FINAL CHECK before returning: every proper noun referring to a\n' +
  'character must match the outline EXACTLY. If the original prose uses\n' +
  'a name variant the outline doesn\'t have, CORRECT it. If the\n' +
  'original treats a character as a stranger when a previous chapter\n' +
  'established them as a friend, CORRECT the framing.\n\n' +

  '# STORY ARC AND GENRE WRITING DIRECTIVE\n' +
  'If the outline names a story arc (Fichtean Curve, Three-Act, etc),\n' +
  'the chapter MUST execute its assigned arc beat for its position in\n' +
  'the book. The genre writing directive loaded from the PROJECT\n' +
  'CONTEXT governs tone, mood, pacing, vocabulary, and intimacy rules\n' +
  '(if applicable). Strictly follow it. Research must not push the\n' +
  'chapter outside the genre.\n\n' +

  '# WHAT "CREDIBILITY" MEANS HERE\n' +
  'Credibility is grounding: when a character in the chapter makes a\n' +
  'constitutional argument, references a historical event, describes a\n' +
  'legal procedure, or uses technical jargon, the underlying fact must\n' +
  'be real (per research). It does NOT mean rewriting the scene around\n' +
  'research topics. It does NOT mean expanding deportation procedure\n' +
  'content if the scene is about a character\'s internal conflict. Keep\n' +
  'the original scene; sharpen the factual details inside it.\n\n' +

  modeBlock + qaBlock + styleBlock + '\n\n' +

  'OUTPUT: return ONLY the rewritten chapter as markdown. No preamble,\n' +
  'no change log, no meta commentary. First line is the chapter heading\n' +
  '(# ' + loaded.chapter_label + (chapter.title ? ' — ' + chapter.title : '') + ').';

const userPrompt =
  '# PROJECT CONTEXT — AUTHORITATIVE TRUTH FOR THIS REWRITE\n' +
  '# (outline, story bible, genre directive, story arc, previous chapters)\n\n' +
  (contextDoc || '_(no project context loaded — proceed with caution)_') +
  '\n\n---\n\n' +
  '# RESEARCH REPORT — reference material only, never overrides the outline\n\n' +
  (researchContent || '_(no research report)_') +
  '\n\n---\n\n' +
  '# ORIGINAL CHAPTER (rewrite this — the prose below may contain the\n' +
  '# exact identity/timeline/arc errors the outline above forbids;\n' +
  '# the outline wins)\n\n' +
  chapterText +
  '\n\n---\n\n' +
  '# FOCUS FOR THIS REWRITE\n' +
  loaded.focus;

return [
  {
    json: {
      ...loaded,
      research_report_id: researchReportId,
      rewrite_system_prompt: systemPrompt,
      rewrite_user_prompt: userPrompt,
    },
  },
];
"""

PACKAGE_AND_SAVE_CODE = r"""// S12-6 — take the Claude rewrite output, persist a content_versions_v2
// snapshot, update published_content_v2.content, and emit the final
// shape expected by the caller.

const loaded = $('build_rewrite_prompt').first().json;
const llm = $input.first().json;
const rewritten = (llm.text || llm.output || llm.response || '').toString().trim();
if (!rewritten) {
  throw new Error('S12-6: Claude returned empty output');
}

const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = {
  apikey: apiKey,
  Authorization: 'Bearer ' + apiKey,
  'Content-Type': 'application/json',
};

const chapter = loaded.chapter || {};

// 1. Insert a content_versions_v2 snapshot. Matches the pattern used
//    by manage_library when we save_version on approve/publish.
// content_versions_v2 schema: content_id, user_id, content_text,
// change_note, changed_by, version_number. Version number is managed
// by a trigger on insert (or we leave it null and let the app pick).
const versionBody = {
  content_id: chapter.id,
  user_id: loaded.user_id,
  content_text: rewritten,
  change_note:
    '[S12-6 rewrite] focus=' + loaded.focus.substring(0, 80) +
    (loaded.research_report_id ? ' (research_id=' + loaded.research_report_id + ')' : ''),
  changed_by: 's12-6-rewrite',
};
let versionId = null;
try {
  const vResp = await this.helpers.httpRequest({
    method: 'POST',
    url: supabaseUrl + '/rest/v1/content_versions_v2',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(versionBody),
  });
  const row = Array.isArray(vResp) ? vResp[0] : vResp;
  versionId = row && row.id;
} catch (e) {
  // If the column naming differs slightly, fail open on the version
  // save and still deliver the rewrite. We do not lose the rewrite
  // because published_content_v2.content is still updated below.
}

// 2. Update published_content_v2.content_text in place. `content` is
// not a column on published_content_v2 — the prose lives in
// `content_text`. Word count lives in the metadata JSONB blob.
const pcUrl =
  supabaseUrl +
  '/rest/v1/published_content_v2?id=eq.' +
  encodeURIComponent(chapter.id);
const newMetadata = {
  ...(chapter.metadata || {}),
  word_count: rewritten.split(/\s+/).filter(Boolean).length,
  last_rewrite: {
    at: new Date().toISOString(),
    research_report_id: loaded.research_report_id || null,
    citations_in_prose: loaded.citations_in_prose,
  },
};
// updated_at is not auto-updated by Supabase on PATCH — there is no
// ON UPDATE trigger on this table — so we set it explicitly. Without
// this the Workbench UI's "Updated" stamp stays frozen at the last
// write-chapter timestamp and the user can't tell a rewrite ran.
//
// genre_slug: chapters can drift out of sync with their project when
// the project's genre is reclassified after chapters are written. The
// rewrite runs under the project's CURRENT genre (via Build Chapter
// Context), so we sync the chapter's genre_slug column to the project
// here. This makes the Content Library display stay honest about what
// genre rules the prose is actually being held to.
const projectGenre = (loaded.project || {}).genre_slug || null;
const patchBody = {
  content_text: rewritten,
  metadata: newMetadata,
  updated_at: new Date().toISOString(),
};
if (projectGenre) patchBody.genre_slug = projectGenre;
await this.helpers.httpRequest({
  method: 'PATCH',
  url: pcUrl,
  headers,
  body: JSON.stringify(patchBody),
});

return [
  {
    json: {
      rewritten_chapter: rewritten,
      chars: rewritten.length,
      research_report_id: loaded.research_report_id,
      citations_in_prose: loaded.citations_in_prose,
      version_id: versionId,
      chapter_id: chapter.id,
      project_title: loaded.project_title,
      chapter_label: loaded.chapter_label,
    },
  },
];
"""


def build_workflow_body() -> dict:
    supabase_key = os.environ["DEV_SUPABASE_SERVICE_ROLE_KEY"]
    anthropic_cred_id = os.environ["ANTHROPIC_CRED_ID"]
    research_pipeline_id = os.environ["RESEARCH_PIPELINE_WF_ID"]
    qa_chapter_wf_id = os.environ.get("QA_CHAPTER_WF_ID", "Z3M57QWR8FCU3Omb")
    context_builder_wf_id = os.environ.get("CONTEXT_BUILDER_WF_ID", "jJe84zB3U1HA9xVv")

    nodes = [
        {
            "parameters": {
                "workflowInputs": {
                    "values": [
                        {"name": "user_id", "type": "string"},
                        {"name": "project_title", "type": "string"},
                        {"name": "chapter_number", "type": "string"},
                        {"name": "research_focus", "type": "string"},
                        {"name": "use_qa_report", "type": "boolean"},
                        {"name": "style_directives", "type": "string"},
                        {"name": "force_citations_in_prose", "type": "boolean"},
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
            "parameters": {"jsCode": LOAD_CHAPTER_CODE},
            "id": "load",
            "name": "load_chapter",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, 0],
        },
        # S12-2 Build Chapter Context sub-workflow. Must run BEFORE
        # the research pipeline so the outline/bible/genre/previous
        # chapters are authoritative over anything the research says.
        # Without this node, Claude rewrites the scene using research
        # topics as the source of truth and drifts character names +
        # plot state badly.
        {
            "parameters": {
                "workflowId": {"__rl": True, "mode": "id", "value": context_builder_wf_id},
                "workflowInputs": {
                    "mappingMode": "defineBelow",
                    "value": {
                        "user_id": "={{ $json.user_id }}",
                        "project_title": "={{ $json.project_title }}",
                        "chapter_number": "={{ $json.chapter_raw }}",
                        "focus": "={{ $json.focus }}",
                        "max_prev_chapters": "={{ 3 }}",
                    },
                    "matchingColumns": [],
                    "schema": [
                        {"id": "bcc1", "displayName": "user_id", "type": "string", "required": False, "defaultMatch": False, "display": True, "canBeUsedToMatch": True},
                        {"id": "bcc2", "displayName": "project_title", "type": "string", "required": False, "defaultMatch": False, "display": True, "canBeUsedToMatch": True},
                        {"id": "bcc3", "displayName": "chapter_number", "type": "string", "required": False, "defaultMatch": False, "display": True, "canBeUsedToMatch": True},
                        {"id": "bcc4", "displayName": "focus", "type": "string", "required": False, "defaultMatch": False, "display": True, "canBeUsedToMatch": True},
                        {"id": "bcc5", "displayName": "max_prev_chapters", "type": "number", "required": False, "defaultMatch": False, "display": True, "canBeUsedToMatch": True},
                    ],
                },
                "options": {},
            },
            "id": "bcc",
            "name": "build_chapter_context",
            "type": "n8n-nodes-base.executeWorkflow",
            "typeVersion": 1.2,
            "position": [560, 0],
        },
        # Call S12-7 research pipeline via executeWorkflow.
        {
            "parameters": {
                "workflowId": {"__rl": True, "mode": "id", "value": research_pipeline_id},
                "workflowInputs": {
                    "mappingMode": "defineBelow",
                    "value": {
                        "user_id": "={{ $json.user_id }}",
                        "project_title": "={{ $json.project_title }}",
                        "chapter_number": "={{ $json.chapter_raw }}",
                        "focus": "={{ $json.focus }}",
                    },
                    "matchingColumns": [],
                    "schema": [
                        {"id": "user_id", "type": "string", "required": True},
                        {"id": "project_title", "type": "string", "required": True},
                        {"id": "chapter_number", "type": "string", "required": True},
                        {"id": "focus", "type": "string", "required": True},
                    ],
                },
                "options": {},
            },
            "id": "rsrch",
            "name": "call_research_pipeline",
            "type": "n8n-nodes-base.executeWorkflow",
            "typeVersion": 1.2,
            "position": [660, 0],
        },
        {
            "parameters": {"jsCode": BUILD_REWRITE_PROMPT_CODE},
            "id": "prmpt",
            "name": "build_rewrite_prompt",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [880, 0],
        },
        # Claude chain call with the credibility-first prompt.
        # chainLlm wants promptType=define + text. We concatenate the
        # system + user prompts in build_rewrite_prompt and feed a single
        # text field. The system role is still honored because the model
        # reads the combined block as the full instruction.
        {
            "parameters": {
                "promptType": "define",
                "text": "={{ $json.rewrite_system_prompt + '\\n\\n---\\n\\n' + $json.rewrite_user_prompt }}",
            },
            "id": "chain",
            "name": "rewrite_llm",
            "type": "@n8n/n8n-nodes-langchain.chainLlm",
            "typeVersion": 1.7,
            "position": [1100, 0],
        },
        {
            "parameters": {
                "model": {"__rl": True, "mode": "list", "value": "claude-sonnet-4-5"},
                "options": {"temperature": 0.6, "maxTokensToSample": 8000},
            },
            "id": "claude",
            "name": "rewrite_claude",
            "type": "@n8n/n8n-nodes-langchain.lmChatAnthropic",
            "typeVersion": 1.3,
            "position": [1100, 200],
            "credentials": {
                "anthropicApi": {"id": anthropic_cred_id, "name": "Anthropic account"}
            },
        },
        {
            "parameters": {"jsCode": PACKAGE_AND_SAVE_CODE},
            "id": "pkg",
            "name": "package_and_save",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1320, 0],
        },
        # Auto-rerun QA on the fresh prose. This is what closes the
        # loop: the rewrite exists to fix QA-flagged drift, so the
        # feedback must happen immediately. DEV - Tool - QA Chapter
        # (Z3M57QWR8FCU3Omb) reads the chapter from the DB, runs the
        # consistency / name / duplicate checks, persists a new QA
        # report in metadata.last_qa_report, and emails the author.
        {
            "parameters": {
                "workflowId": {"__rl": True, "mode": "id", "value": qa_chapter_wf_id},
                "workflowInputs": {
                    "mappingMode": "defineBelow",
                    "value": {
                        "project_title": "={{ $json.project_title }}",
                        "chapter_number": "={{ $('load_chapter').first().json.chapter_raw }}",
                        "user_id": "={{ $('load_chapter').first().json.user_id }}",
                        "user_prompt": "=[S12-6 auto-rerun after rewrite] focus: {{ $('load_chapter').first().json.focus }}",
                        "recipient_email": "",
                        "bcc_email": "",
                    },
                    "matchingColumns": [],
                    "schema": [
                        {"id": "q1", "displayName": "project_title", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                        {"id": "q2", "displayName": "chapter_number", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                        {"id": "q3", "displayName": "user_id", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                        {"id": "q4", "displayName": "user_prompt", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                        {"id": "q5", "displayName": "recipient_email", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                        {"id": "q6", "displayName": "bcc_email", "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True},
                    ],
                },
                "options": {},
            },
            "id": "qa_rerun",
            "name": "qa_rerun",
            "type": "n8n-nodes-base.executeWorkflow",
            "typeVersion": 1.2,
            "position": [1540, 0],
        },
        # Final merger: combine the rewrite payload (pre-QA) with the
        # QA rerun result so the hub gets one clean response.
        {
            "parameters": {
                "jsCode": (
                    "// S12-8 — merge package_and_save output with qa_rerun output.\n"
                    "// Fails open on QA errors: the rewrite is already delivered, a\n"
                    "// QA failure must not roll back or hide that.\n"
                    "const pkg = $('package_and_save').first().json;\n"
                    "const qa = $input.first().json || {};\n"
                    "const qaResult = qa.result || qa.qa_result || qa.output || '';\n"
                    "return [{ json: {\n"
                    "  ...pkg,\n"
                    "  qa_rerun: {\n"
                    "    status: (typeof qaResult === 'string' && qaResult.toLowerCase().includes('passed q/a')) ? 'PASS' : 'NEEDS_REVIEW',\n"
                    "    summary: typeof qaResult === 'string' ? qaResult.slice(0, 1000) : '(non-string result)',\n"
                    "    tool_workflow_id: 'Z3M57QWR8FCU3Omb',\n"
                    "  },\n"
                    "} }];\n"
                ),
            },
            "id": "final_merge",
            "name": "final_output",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1760, 0],
        },
    ]

    connections = {
        "workflow_trigger": {"main": [[{"node": "settings", "type": "main", "index": 0}]]},
        "settings": {"main": [[{"node": "load_chapter", "type": "main", "index": 0}]]},
        "load_chapter": {
            "main": [[{"node": "build_chapter_context", "type": "main", "index": 0}]]
        },
        "build_chapter_context": {
            "main": [[{"node": "call_research_pipeline", "type": "main", "index": 0}]]
        },
        "call_research_pipeline": {
            "main": [[{"node": "build_rewrite_prompt", "type": "main", "index": 0}]]
        },
        "build_rewrite_prompt": {
            "main": [[{"node": "rewrite_llm", "type": "main", "index": 0}]]
        },
        "rewrite_llm": {
            "main": [[{"node": "package_and_save", "type": "main", "index": 0}]]
        },
        "package_and_save": {
            "main": [[{"node": "qa_rerun", "type": "main", "index": 0}]]
        },
        "qa_rerun": {
            "main": [[{"node": "final_output", "type": "main", "index": 0}]]
        },
        "rewrite_claude": {
            "ai_languageModel": [
                [{"node": "rewrite_llm", "type": "ai_languageModel", "index": 0}]
            ]
        },
    }

    return {
        "name": WORKFLOW_NAME,
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }


def main() -> int:
    for var in (
        "DEV_SUPABASE_SERVICE_ROLE_KEY",
        "ANTHROPIC_CRED_ID",
        "RESEARCH_PIPELINE_WF_ID",
    ):
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
        api("PUT", f"/workflows/{existing}", clean_workflow_put_body(body))
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
