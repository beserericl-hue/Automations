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
const projectTitle = (trig.project_title || '').toString();
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

BUILD_REWRITE_PROMPT_CODE = r"""// S12-6 — assemble the credibility-first rewrite prompt from the
// loaded chapter + the research report the S12-7 pipeline just
// produced.

const loaded = $('load_chapter').first().json;
const research = $('call_research_pipeline').first().json;

const researchContent = research.content || '';
const researchReportId = research.research_report_id || null;

const style = loaded.style_directives;
const qa = loaded.qa_report;
const chapter = loaded.chapter || {};
const chapterText = chapter.content || '';

// Credibility-first directive. The prose itself stays fiction; the
// facts that back character arguments, historical references, legal
// procedures, and technical vocabulary come from the research report.
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
      'research report below is your research notes, not a bibliography\n' +
      'to quote. Use the facts in it to make character arguments,\n' +
      'historical references, vocabulary, and procedural descriptions\n' +
      'credible. When a character cites a case, makes a constitutional\n' +
      'argument, describes a historical event, or invokes technical\n' +
      'jargon, the underlying fact must match the research — but the\n' +
      'prose reads like fiction, not like a footnoted essay.\n' +
      'If you cannot ground a claim in the research without sounding\n' +
      'like you are citing it, rewrite the sentence so the claim is\n' +
      'conveyed through action, dialogue, or observation instead.'
    );

const qaBlock = (qa && typeof qa === 'string' && qa.trim())
  ? '\n\nQ/A REPORT TO ADDRESS:\n' + qa.trim() + '\n'
  : '';

const styleBlock = style
  ? '\n\nSTYLE DIRECTIVES:\n' + style + '\n'
  : '';

const systemPrompt =
  'You are rewriting one chapter of a novel with the goal of grounding\n' +
  'it in real, verifiable facts without sacrificing its fiction voice.\n' +
  'You are the author, not a critic. Preserve the chapter structure,\n' +
  'pacing, point of view, and character voice unless the style\n' +
  'directives say otherwise.\n\n' +
  modeBlock + qaBlock + styleBlock + '\n\n' +
  'OUTPUT: return ONLY the rewritten chapter as markdown. No preamble,\n' +
  'no closing note, no meta commentary. The first line should be the\n' +
  'chapter heading (# ' + loaded.chapter_label + (chapter.title ? ' — ' + chapter.title : '') + ').';

const userPrompt =
  'RESEARCH REPORT (reference material — not a bibliography to quote):\n\n' +
  researchContent +
  '\n\n---\n\n' +
  'ORIGINAL CHAPTER (rewrite this):\n\n' +
  chapterText +
  '\n\n---\n\n' +
  'FOCUS FOR THIS REWRITE: ' + loaded.focus;

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
await this.helpers.httpRequest({
  method: 'PATCH',
  url: pcUrl,
  headers,
  body: JSON.stringify({
    content_text: rewritten,
    metadata: newMetadata,
  }),
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
    ]

    connections = {
        "workflow_trigger": {"main": [[{"node": "settings", "type": "main", "index": 0}]]},
        "settings": {"main": [[{"node": "load_chapter", "type": "main", "index": 0}]]},
        "load_chapter": {
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
