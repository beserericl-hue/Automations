#!/usr/bin/env python3
"""
Sprint 12 S12-7: create DEV - Sub - Research Pipeline.

Standalone sub-workflow that turns a research focus + chapter context
into a markdown research report with source citations, persisted to
research_reports_v2 for audit trail and future retrieval.

Design (credibility-first model):
  - Research grounds prose invisibly. The research report preserves
    citations separately so the author (and admin UI) can audit every
    factual claim, but the fiction rewrite tool consumes the report
    as context only — it never injects footnote markers into prose.

Inputs:
  user_id            — required
  project_title      — required
  chapter_number     — required (Prologue / Epilogue / N)
  focus              — required, 1-3 sentence theme
  n_questions        — optional, default 5 (clamped 1..8)
  questions          — optional array<string> — if provided, skips
                       the Claude question-derivation step

Output:
  research_report_id — UUID of the newly-inserted row
  content            — the full markdown report
  chars              — byte count for telemetry
  source_count       — number of distinct citations surfaced

No base-table changes. We persist into research_reports_v2's existing
columns (topic, content, genre_slug, status). The topic field encodes
the source: "[CH{N} Rewrite] {focus}".

Usage:
  N8N_API_KEY=...
  DEV_SUPABASE_SERVICE_ROLE_KEY=...
  PERPLEXITY_CRED_ID=...   # existing credential id on this n8n
  ANTHROPIC_CRED_ID=...    # existing credential id on this n8n
  python3 scripts/s12-7-create-research-pipeline.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
WORKFLOW_NAME = "DEV - Sub - Research Pipeline"

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

NORMALIZE_INPUT_CODE = r"""// S12-7 — normalize the incoming payload and resolve the project.
// Returns { user_id, project_title, chapter_label, focus, n_questions,
//           questions[], project: { id, genre_slug } }

const trig = $('workflow_trigger').first().json;
const userId = (trig.user_id || '').toString();
const projectTitle = (trig.project_title || '').toString();
const chapterRaw = trig.chapter_number;
const focus = (trig.focus || '').toString().trim();

if (!userId) throw new Error('S12-7: user_id is required');
if (!projectTitle) throw new Error('S12-7: project_title is required');
if (!focus) throw new Error('S12-7: focus is required');

function chapterLabel(v) {
  if (v == null || v === '') return 'Chapter';
  const s = v.toString().toLowerCase();
  if (s === 'prologue' || s === '0') return 'Prologue';
  if (s === 'epilogue') return 'Epilogue';
  return 'Chapter ' + v;
}

const nReqRaw = trig.n_questions;
const nReq = Number.isFinite(+nReqRaw) ? Math.max(1, Math.min(8, +nReqRaw)) : 5;

const preQuestions = Array.isArray(trig.questions)
  ? trig.questions.map((q) => q.toString().trim()).filter(Boolean)
  : [];

const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = { apikey: apiKey, Authorization: 'Bearer ' + apiKey };

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
  throw new Error('S12-7: project not found for user=' + userId + ' title=' + projectTitle);
}

return [
  {
    json: {
      user_id: userId,
      project_title: projectTitle,
      chapter_raw: chapterRaw,
      chapter_label: chapterLabel(chapterRaw),
      focus,
      n_questions: nReq,
      questions: preQuestions,
      project: {
        id: project.id,
        genre_slug: project.genre_slug,
        project_type: project.project_type || 'fiction',
      },
    },
  },
];
"""

DERIVE_QUESTIONS_CODE = r"""// S12-7 — if the caller supplied explicit questions, pass them through.
// Otherwise build a Claude prompt that derives n focused research
// questions from the focus statement. We emit the prompt here and let
// the downstream Claude node answer; the parse step splits the reply.

const d = $input.first().json;
if (d.questions && d.questions.length > 0) {
  // Caller supplied questions. Short-circuit by emitting a synthetic
  // "answer" that the parse step will recognise.
  return [
    {
      json: {
        ...d,
        _synthetic_answer: d.questions
          .map((q, i) => (i + 1) + '. ' + q)
          .join('\n'),
      },
    },
  ];
}

const prompt =
  'You are a research planner helping a novelist. Based on the focus\n' +
  'statement below, generate EXACTLY ' + d.n_questions + ' specific, answerable\n' +
  'research questions that would let the novelist ground the prose in\n' +
  'real facts (events, arguments, locations, procedures, vocabulary).\n' +
  'Questions must be self-contained — no pronouns referring to the\n' +
  'focus. Output ONLY a numbered list, one question per line.\n\n' +
  'Project: ' + d.project_title + '\n' +
  'Chapter: ' + d.chapter_label + '\n' +
  'Focus: ' + d.focus;

return [{ json: { ...d, _question_prompt: prompt } }];
"""

PARSE_QUESTIONS_CODE = r"""// S12-7 — parse Claude's numbered-list answer into questions[]. If the
// caller supplied questions up front, pass them through.

const d = $('normalize_input').first().json;
let raw;
if (d.questions && d.questions.length > 0) {
  raw = d.questions.map((q, i) => (i + 1) + '. ' + q).join('\n');
} else {
  const llm = $input.first().json;
  raw = (llm.text || llm.output || llm.response || '').toString();
}

const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
const questions = lines
  .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
  .filter((q) => q.length > 3)
  .slice(0, d.n_questions);

if (questions.length === 0) {
  throw new Error('S12-7: failed to derive any research questions');
}

// Emit one item per question so the Perplexity node fans out over them.
return questions.map((q, i) => ({
  json: {
    ...d,
    _question_index: i,
    _question: q,
  },
}));
"""

COMPILE_REPORT_CODE = r"""// S12-7 — compile the Perplexity per-question answers into a single
// markdown research report with a deduplicated citations section.
//
// Expected: $input.all() has one item per question, each with the
// Perplexity node's output in .json (typically { message, citations[] }
// when simplify=true).

const items = $input.all();
const d = $('normalize_input').first().json;

const sections = [];
const seenCitations = new Map(); // url -> { title, first_question_index }

for (let i = 0; i < items.length; i++) {
  const it = items[i].json || {};
  const q = it._question || (it.question || '(unnamed question)');
  const msg = (it.message || it.answer || it.response || '').toString().trim();
  const cites = Array.isArray(it.citations) ? it.citations : [];

  sections.push('### Q' + (i + 1) + '. ' + q);
  sections.push('');
  sections.push(msg || '_(no answer)_');
  if (cites.length) {
    sections.push('');
    sections.push('_Sources:_');
    for (const c of cites) {
      const url = typeof c === 'string' ? c : c.url || '';
      const title = typeof c === 'object' ? c.title || url : url;
      if (!url) continue;
      if (!seenCitations.has(url)) {
        seenCitations.set(url, { title, first_q: i + 1 });
      }
      sections.push('- [' + title + '](' + url + ')');
    }
  }
  sections.push('');
}

const header = [
  '# Research Report — ' + d.chapter_label,
  '',
  '**Project:** ' + d.project_title,
  '**Focus:** ' + d.focus,
  '**Generated:** ' + new Date().toISOString(),
  '',
  '> Credibility-first report. Used by chapter rewrite tools to ground',
  '> prose in real facts. Citations are preserved in this report; the',
  '> rewritten prose does NOT surface footnote markers for fiction.',
  '',
].join('\n');

const citationList = [];
if (seenCitations.size > 0) {
  citationList.push('## All Sources');
  citationList.push('');
  let n = 1;
  for (const [url, info] of seenCitations.entries()) {
    citationList.push(n + '. [' + info.title + '](' + url + ')  _(Q' + info.first_q + ')_');
    n++;
  }
  citationList.push('');
}

const body = ['## Questions & Findings', '', ...sections].join('\n');
const content = header + body + '\n' + citationList.join('\n');

return [
  {
    json: {
      ...d,
      content,
      chars: content.length,
      source_count: seenCitations.size,
      n_questions_answered: items.length,
    },
  },
];
"""

SAVE_REPORT_RESPONSE_CODE = r"""// S12-7 — take the Supabase insert response and emit the canonical
// S12-7 output shape.

const resp = $input.first().json;
const compiled = $('compile_report').first().json;

// Supabase returns an array when Prefer: return=representation.
const row = Array.isArray(resp) ? resp[0] : resp;

return [
  {
    json: {
      research_report_id: (row && row.id) || null,
      content: compiled.content,
      chars: compiled.chars,
      source_count: compiled.source_count,
      n_questions_answered: compiled.n_questions_answered,
      project: compiled.project,
    },
  },
];
"""


def build_workflow_body() -> dict:
    supabase_key = os.environ["DEV_SUPABASE_SERVICE_ROLE_KEY"]
    perplexity_cred_id = os.environ["PERPLEXITY_CRED_ID"]
    anthropic_cred_id = os.environ["ANTHROPIC_CRED_ID"]

    nodes = [
        {
            "parameters": {
                "workflowInputs": {
                    "values": [
                        {"name": "user_id", "type": "string"},
                        {"name": "project_title", "type": "string"},
                        {"name": "chapter_number", "type": "string"},
                        {"name": "focus", "type": "string"},
                        {"name": "n_questions", "type": "number"},
                        {"name": "questions", "type": "array"},
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
                        {
                            "id": "u",
                            "name": "SUPABASE_URL",
                            "value": DEV_SUPABASE_URL,
                            "type": "string",
                        },
                        {
                            "id": "k",
                            "name": "SUPABASE_API_KEY",
                            "value": supabase_key,
                            "type": "string",
                        },
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
            "parameters": {"jsCode": NORMALIZE_INPUT_CODE},
            "id": "norm",
            "name": "normalize_input",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, 0],
        },
        {
            "parameters": {"jsCode": DERIVE_QUESTIONS_CODE},
            "id": "der",
            "name": "derive_questions_prompt",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [660, 0],
        },
        # Claude question-deriver (chain node). Skipped if questions[] was
        # supplied — downstream parse node detects that and passes through.
        # chainLlm needs promptType=define + text; messageValues form
        # does not resolve and errors with "No prompt specified".
        {
            "parameters": {
                "promptType": "define",
                "text": "={{ $json._question_prompt || ' ' }}",
            },
            "id": "qchain",
            "name": "derive_questions_llm",
            "type": "@n8n/n8n-nodes-langchain.chainLlm",
            "typeVersion": 1.7,
            "position": [880, 0],
        },
        {
            "parameters": {
                "model": {"__rl": True, "mode": "list", "value": "claude-sonnet-4-5"},
                "options": {"temperature": 0.2, "maxTokensToSample": 512},
            },
            "id": "qclaude",
            "name": "derive_questions_claude",
            "type": "@n8n/n8n-nodes-langchain.lmChatAnthropic",
            "typeVersion": 1.3,
            "position": [880, 200],
            "credentials": {
                "anthropicApi": {"id": anthropic_cred_id, "name": "Anthropic account"}
            },
        },
        {
            "parameters": {"jsCode": PARSE_QUESTIONS_CODE},
            "id": "parseq",
            "name": "parse_questions",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1100, 0],
        },
        # Perplexity research node — fires once per item (per question).
        {
            "parameters": {
                "messages": {
                    "message": [
                        {
                            "content": (
                                "=You are a research assistant for a novelist. Answer the "
                                "question in 3-6 paragraphs, prioritising verifiable facts "
                                "over narrative. Cite authoritative sources."
                            ),
                            "role": "system",
                        },
                        {"content": "={{ $json._question }}"},
                    ]
                },
                "simplify": True,
                "options": {"temperature": 0.1, "searchRecency": "year"},
                "requestOptions": {},
            },
            "id": "perp",
            "name": "perplexity_answer",
            "type": "n8n-nodes-base.perplexity",
            "typeVersion": 1,
            "position": [1320, 0],
            "credentials": {
                "perplexityApi": {"id": perplexity_cred_id, "name": "Perplexity"}
            },
        },
        {
            "parameters": {"jsCode": COMPILE_REPORT_CODE},
            "id": "comp",
            "name": "compile_report",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1540, 0],
        },
        # Insert into research_reports_v2 — stays within the additive
        # columns (topic/content/genre_slug/status), no schema changes.
        {
            "parameters": {
                "method": "POST",
                "url": "={{ $('settings').first().json.SUPABASE_URL }}/rest/v1/research_reports_v2",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "apikey", "value": "={{ $('settings').first().json.SUPABASE_API_KEY }}"},
                        {"name": "Authorization", "value": "=Bearer {{ $('settings').first().json.SUPABASE_API_KEY }}"},
                        {"name": "Content-Type", "value": "application/json"},
                        {"name": "Prefer", "value": "return=representation"},
                    ]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": (
                    "={{ JSON.stringify({"
                    " user_id: $json.user_id,"
                    " topic: '[' + $json.chapter_label + ' Rewrite] ' + $json.focus,"
                    " genre_slug: $json.project.genre_slug,"
                    " content: $json.content,"
                    " status: 'completed'"
                    " }) }}"
                ),
                "options": {},
            },
            "id": "save",
            "name": "save_report",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1760, 0],
        },
        {
            "parameters": {"jsCode": SAVE_REPORT_RESPONSE_CODE},
            "id": "resp",
            "name": "shape_output",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1980, 0],
        },
    ]

    connections = {
        "workflow_trigger": {"main": [[{"node": "settings", "type": "main", "index": 0}]]},
        "settings": {"main": [[{"node": "normalize_input", "type": "main", "index": 0}]]},
        "normalize_input": {
            "main": [[{"node": "derive_questions_prompt", "type": "main", "index": 0}]]
        },
        "derive_questions_prompt": {
            "main": [[{"node": "derive_questions_llm", "type": "main", "index": 0}]]
        },
        "derive_questions_llm": {
            "main": [[{"node": "parse_questions", "type": "main", "index": 0}]]
        },
        "derive_questions_claude": {
            "ai_languageModel": [
                [
                    {
                        "node": "derive_questions_llm",
                        "type": "ai_languageModel",
                        "index": 0,
                    }
                ]
            ]
        },
        "parse_questions": {
            "main": [[{"node": "perplexity_answer", "type": "main", "index": 0}]]
        },
        "perplexity_answer": {
            "main": [[{"node": "compile_report", "type": "main", "index": 0}]]
        },
        "compile_report": {"main": [[{"node": "save_report", "type": "main", "index": 0}]]},
        "save_report": {"main": [[{"node": "shape_output", "type": "main", "index": 0}]]},
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
        "PERPLEXITY_CRED_ID",
        "ANTHROPIC_CRED_ID",
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
