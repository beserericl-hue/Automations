#!/usr/bin/env python3
"""
Sprint 12 S12-2: create DEV - Sub - Build Chapter Context.

New sub-workflow called by DEV - Worker - Write Chapter (and later by
DEV - Tool - Rewrite Chapter with Research in S12-6). It bundles the
5 reads the Worker currently does sequentially at the top of its flow
into one code node that issues them in parallel, then produces a
single markdown `context_document` the sub-chapter LLM calls can use
verbatim.

Inputs (executeWorkflow payload):
  user_id            — required
  project_title      — required
  chapter_number     — required (may be "Prologue" / "Epilogue")
  focus              — optional, 1-line summary the caller wants
                       privileged in the context
  max_prev_chapters  — optional int, default 3 (cap on previous
                       chapter summaries to keep the doc bounded)

Output (single item):
  context_document   — markdown string the LLM ingests
  chars              — length for telemetry
  source_data        — per-section sizes (for debug / admin views)

Replay-safe: idempotent. If a workflow with the same name already
exists the script updates it in place.

Usage:
  N8N_API_KEY=... python3 scripts/s12-2-create-context-builder.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
DEV_WORKFLOW_NAME = "DEV - Sub - Build Chapter Context"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# DEV Supabase (matches the pattern used by DEV - Sub - Manage Story Bible).
# The REST key is an env var so the script does not carry secrets in source.
# In an operator session: export DEV_SUPABASE_SERVICE_ROLE_KEY=... before running.
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


# --------------------------------------------------------------------
# Node definitions

FETCH_ALL_CODE = r"""// S12-2 — fetch project, story bible, genre, previous chapters, story arc
// in parallel. Returns a single item with {project, storyBible, genre,
// previousChapters, storyArc, meta}.
//
// Kept in one Code node (rather than five HTTP nodes) so the five
// reads fire concurrently via Promise.all — the whole sub-workflow
// should resolve in <2s on a warm path.

const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = {
  apikey: apiKey,
  Authorization: 'Bearer ' + apiKey,
  'Content-Type': 'application/json',
};

const trig = $('workflow_trigger').first().json;
const userId = (trig.user_id || '').toString();
const projectTitle = (trig.project_title || '').toString();
const chapterNumRaw = trig.chapter_number;
const maxPrev = Number.isFinite(+trig.max_prev_chapters) ? +trig.max_prev_chapters : 3;

if (!projectTitle) {
  throw new Error('S12-2: project_title is required');
}

// Resolve chapter number to a numeric bound for "previous chapters".
// Prologue = 0 (has no "previous"), Epilogue = 999 (treats every
// written chapter as previous).
function parseChapter(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = v.toString().toLowerCase();
  if (s === 'prologue') return 0;
  if (s === 'epilogue') return 999;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
const chapterNum = parseChapter(chapterNumRaw);

// 1. Fetch project (by title + user)
let projectUrl =
  supabaseUrl +
  '/rest/v1/writing_projects_v2?title=eq.' +
  encodeURIComponent(projectTitle) +
  '&limit=1';
if (userId) projectUrl += '&user_id=eq.' + encodeURIComponent(userId);

const projectResp = await this.helpers.httpRequest({
  method: 'GET',
  url: projectUrl,
  headers,
});
const project = Array.isArray(projectResp) ? projectResp[0] : projectResp;
if (!project || !project.id) {
  return [
    {
      json: {
        error: 'project_not_found',
        message: 'No writing_projects_v2 row for title=' + projectTitle + ' user_id=' + userId,
        project: null,
      },
    },
  ];
}

const projectId = project.id;
const genreSlug = project.genre_slug || null;
const storyArcName =
  (project.outline && project.outline.story_arc_name) ||
  (project.outline && project.outline.book_arc_name) ||
  null;

// 2-5. Parallel reads.
async function safeGet(url) {
  try {
    const r = await this.helpers.httpRequest({ method: 'GET', url, headers });
    return Array.isArray(r) ? r : r ? [r] : [];
  } catch (e) {
    return [];
  }
}
const _safeGet = safeGet.bind(this);

const bibleUrl =
  supabaseUrl +
  '/rest/v1/story_bible_v2?project_id=eq.' +
  encodeURIComponent(projectId) +
  '&order=entry_type,name&limit=500';

const genreUrl = genreSlug
  ? supabaseUrl +
    '/rest/v1/genre_config_v2?genre_slug=eq.' +
    encodeURIComponent(genreSlug) +
    '&limit=1'
  : null;

const arcUrl = storyArcName
  ? supabaseUrl +
    '/rest/v1/story_arcs_v2?name=ilike.' +
    encodeURIComponent(storyArcName) +
    '&limit=1'
  : null;

// Previous chapters: chapter_number < this number, sorted desc, capped.
// "chapter_number" in published_content_v2 is stored as text; string
// comparison is unsafe, so we fetch all chapters for this project and
// filter in JS.
const chaptersUrl =
  supabaseUrl +
  '/rest/v1/published_content_v2?project_id=eq.' +
  encodeURIComponent(projectId) +
  "&content_type=eq.chapter&deleted_at=is.null&select=chapter_number,title,summary,word_count,created_at&order=created_at.desc&limit=50";

const [bible, genre, arc, chapters] = await Promise.all([
  _safeGet(bibleUrl),
  genreUrl ? _safeGet(genreUrl) : Promise.resolve([]),
  arcUrl ? _safeGet(arcUrl) : Promise.resolve([]),
  _safeGet(chaptersUrl),
]);

// Filter previous chapters: numeric < chapterNum (or all if Epilogue).
const previousChapters = chapters
  .map((c) => {
    const cn = parseChapter(c.chapter_number);
    return { ...c, _cn: cn };
  })
  .filter((c) => c._cn != null && c._cn > 0 && c._cn < 999 && (chapterNum == null || c._cn < chapterNum))
  .sort((a, b) => a._cn - b._cn)
  .slice(-maxPrev);

return [
  {
    json: {
      project,
      storyBible: bible,
      genre: genre[0] || null,
      storyArc: arc[0] || null,
      previousChapters,
      meta: {
        chapter_num: chapterNum,
        max_prev_chapters: maxPrev,
        genre_slug: genreSlug,
        story_arc_name: storyArcName,
      },
    },
  },
];
"""

BUILD_CONTEXT_CODE = r"""// S12-2 — render a single markdown context document from the
// fetched project/bible/genre/previous/arc data.

const data = $input.first().json;
if (data.error) {
  return [{ json: { context_document: '', chars: 0, error: data.error, message: data.message } }];
}

const project = data.project || {};
const bible = data.storyBible || [];
const genre = data.genre || null;
const arc = data.storyArc || null;
const prev = data.previousChapters || [];
const trig = $('workflow_trigger').first().json;
const focus = (trig.focus || '').toString().trim();
const chapterNumRaw = trig.chapter_number;

const parts = [];

parts.push(`# Chapter Context`);
parts.push(`**Project:** ${project.title || '(untitled)'}`);
if (chapterNumRaw != null) parts.push(`**Chapter:** ${chapterNumRaw}`);
if (project.genre_slug) parts.push(`**Genre:** ${project.genre_slug}`);
if (focus) parts.push(`**Focus this chapter:** ${focus}`);
parts.push('');

if (genre && genre.writing_directive) {
  parts.push('## Writing Prime Directive (genre)');
  parts.push(genre.writing_directive.toString().trim());
  parts.push('');
}

if (arc) {
  parts.push(`## Story Arc: ${arc.name}`);
  if (arc.description) parts.push(arc.description.toString().trim());
  if (arc.prompt_text) {
    parts.push('');
    parts.push('### Arc directives');
    parts.push(arc.prompt_text.toString().trim());
  }
  parts.push('');
}

// Outline — just the chapters array and top-level premise.
if (project.outline && typeof project.outline === 'object') {
  const o = project.outline;
  parts.push('## Book Outline');
  if (o.premise) parts.push(`**Premise:** ${o.premise}`);
  if (o.theme) parts.push(`**Theme:** ${o.theme}`);
  if (Array.isArray(o.characters) && o.characters.length) {
    parts.push('');
    parts.push('### Characters');
    for (const c of o.characters) {
      const line =
        `- **${c.name || 'Unnamed'}**` +
        (c.role ? ` — ${c.role}` : '') +
        (c.age != null ? ` (age ${c.age})` : '') +
        (c.description ? `: ${c.description}` : '');
      parts.push(line);
    }
  }
  if (Array.isArray(o.chapters) && o.chapters.length) {
    parts.push('');
    parts.push('### Chapter map');
    for (const ch of o.chapters) {
      const label = ch.number != null ? `Ch ${ch.number}` : '(no number)';
      parts.push(`- **${label}** — ${ch.title || ''}: ${ch.brief || ch.summary || ''}`);
    }
  }

  // TARGET CHAPTER detail — when the caller identified which chapter
  // is being worked on, expand its chapter_outline.sub_chapters so
  // downstream tools (rewrite, write_chapter) can see the required
  // titled sections + per-sub briefs. Without this, Claude writes a
  // single continuous narrative even when the outline defines 5
  // titled sub-chapters like "Evening Routine / The Forms / The
  // Mirror / The Protocol / The Counting".
  const targetNum = data.meta && data.meta.chapter_num;
  if (targetNum != null && Array.isArray(o.chapters)) {
    let targetCh = null;
    if (targetNum === 0) targetCh = o.chapters[0];
    else if (targetNum === 999) targetCh = o.chapters[o.chapters.length - 1];
    else targetCh = o.chapters.find((x) => x.number === targetNum) || null;
    if (targetCh) {
      const co = targetCh.chapter_outline || {};
      const subs = Array.isArray(co.sub_chapters) ? co.sub_chapters : [];
      parts.push('');
      parts.push(`### THIS CHAPTER (${targetCh.title || 'Ch ' + targetNum}) — REQUIRED STRUCTURE`);
      if (co.chapter_story_arc) parts.push(`**Chapter story arc:** ${co.chapter_story_arc}`);
      if (co.book_arc_beat) parts.push(`**Book arc beat:** ${co.book_arc_beat}`);
      if (co.chapter_summary) parts.push(`**Chapter summary:** ${co.chapter_summary}`);
      if (subs.length) {
        parts.push('');
        parts.push(`**Sub-chapters (${subs.length}) — MUST appear as titled sections in this exact order:**`);
        for (const s of subs) {
          const n = s.number != null ? s.number : '?';
          parts.push(`${n}. **${s.title || '(untitled)'}**`);
          if (s.arc_beat) parts.push(`   - Arc beat: ${s.arc_beat}`);
          if (s.setting) parts.push(`   - Setting: ${s.setting}`);
          if (Array.isArray(s.characters) && s.characters.length) parts.push(`   - Characters: ${s.characters.join(', ')}`);
          if (s.brief) parts.push(`   - Brief: ${s.brief}`);
        }
      } else {
        parts.push('_(no sub-chapter outline — chapter may be written as a single scene)_');
      }
    }
  }

  parts.push('');
}

if (bible.length) {
  parts.push('## Story Bible');
  // Group by entry_type.
  const groups = {};
  for (const e of bible) {
    const k = e.entry_type || 'other';
    (groups[k] = groups[k] || []).push(e);
  }
  for (const k of Object.keys(groups)) {
    parts.push(`### ${k}`);
    for (const e of groups[k]) {
      parts.push(`- **${e.name || '(unnamed)'}** — ${(e.description || '').toString().trim()}`);
    }
    parts.push('');
  }
}

if (prev.length) {
  parts.push('## Previous Chapters (most recent last)');
  for (const c of prev) {
    parts.push(`### Chapter ${c.chapter_number}${c.title ? ' — ' + c.title : ''}`);
    if (c.summary) parts.push(c.summary.toString().trim());
    if (c.word_count) parts.push(`_Word count: ${c.word_count}_`);
    parts.push('');
  }
}

const doc = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

return [
  {
    json: {
      context_document: doc,
      chars: doc.length,
      source_data: {
        has_project: !!project.id,
        bible_entries: bible.length,
        genre_loaded: !!genre,
        arc_loaded: !!arc,
        previous_chapters: prev.length,
      },
    },
  },
];
"""


def build_workflow_body() -> dict:
    # Node IDs are stable so updates re-match connections cleanly.
    nodes = [
        {
            "parameters": {
                "workflowInputs": {
                    "values": [
                        {"name": "user_id", "type": "string"},
                        {"name": "project_title", "type": "string"},
                        {"name": "chapter_number", "type": "string"},
                        {"name": "focus", "type": "string"},
                        {"name": "max_prev_chapters", "type": "number"},
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
                            "id": "s1",
                            "name": "SUPABASE_URL",
                            "value": DEV_SUPABASE_URL,
                            "type": "string",
                        },
                        {
                            "id": "sapi",
                            "name": "SUPABASE_API_KEY",
                            "value": os.environ.get("DEV_SUPABASE_SERVICE_ROLE_KEY", ""),
                            "type": "string",
                        },
                    ],
                },
                "options": {},
            },
            "id": "settings",
            "name": "settings",
            "type": "n8n-nodes-base.set",
            "typeVersion": 3.4,
            "position": [220, 0],
        },
        {
            "parameters": {"jsCode": FETCH_ALL_CODE},
            "id": "fetch",
            "name": "fetch_all",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, 0],
        },
        {
            "parameters": {"jsCode": BUILD_CONTEXT_CODE},
            "id": "build",
            "name": "build_context",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [660, 0],
        },
    ]
    connections = {
        "workflow_trigger": {
            "main": [[{"node": "settings", "type": "main", "index": 0}]],
        },
        "settings": {
            "main": [[{"node": "fetch_all", "type": "main", "index": 0}]],
        },
        "fetch_all": {
            "main": [[{"node": "build_context", "type": "main", "index": 0}]],
        },
    }
    return {
        "name": DEV_WORKFLOW_NAME,
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }


def find_existing_by_name(name: str) -> str | None:
    # API has no by-name endpoint — list and scan.
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


def main() -> int:
    if not os.environ.get("DEV_SUPABASE_SERVICE_ROLE_KEY"):
        print(
            "DEV_SUPABASE_SERVICE_ROLE_KEY not set — the script would write an "
            "empty SUPABASE_API_KEY into the workflow. Export it before running.",
            file=sys.stderr,
        )
        return 2
    body = build_workflow_body()
    existing = find_existing_by_name(DEV_WORKFLOW_NAME)
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

    print(f"DEV - Sub - Build Chapter Context: {wf_id} (active)")
    print(f"Called via executeWorkflow with id={wf_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
