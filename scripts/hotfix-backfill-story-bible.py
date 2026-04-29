#!/usr/bin/env python3
"""
One-shot story-bible backfill for projects written under the broken
sub-chapter architecture (no `new_story_bible_entries` were ever emitted).

This script DOES NOT modify chapters. It:
  1. Reads the project + outline + existing story_bible from DEV Supabase.
  2. Reads every chapter's content_text.
  3. Calls the n8n DEV hub via a single-purpose backfill webhook that
     runs the same extract_bible_prepare → extract_bible_llm chain we
     just added to Worker - Write Chapter (idempotent).

But — to avoid building a new webhook + standing up another workflow —
this script instead creates the n8n backfill workflow inline (a
single-shot worker), runs it once via the executeWorkflow REST API for
each chapter, and removes nothing. The workflow stays available for
future backfills.

Usage:
  N8N_API_KEY=...
  python3 scripts/hotfix-backfill-story-bible.py \
    --project-id 366ca0a0-18e8-45a5-83da-a6b3d23d760b \
    --user-id "+14105914612"

Outputs a per-chapter insert count and a final summary.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
DEV_SUPABASE_URL = "https://gvbvwcnmjkdpclcisqrr.supabase.co"
WEBHOOK_PATH = "story_bible_backfill_dev"
WEBHOOK_URL = f"{N8N_BASE}/webhook/{WEBHOOK_PATH}"
WORKFLOW_NAME = "DEV - Sub - Backfill Story Bible (one-shot)"
ANTHROPIC_CRED_ID = "5LhCYKsaFO3fF7II"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# Embedded JS — same prompt logic as the worker's extract_bible_prepare,
# but operating on a single chapter passed in via webhook body.

PREPARE_CODE = r"""// One-shot bible extraction prompt for a single chapter.
const trig = $('webhook_trigger').first().json.body || $('webhook_trigger').first().json;
const project = $('load_project').first().json.project || {};
const chapter = $('load_chapter').first().json;
const existing = Array.isArray(project.story_bible) ? project.story_bible : [];
const outline = project.outline || {};
const outlineCharacters = Array.isArray(outline.characters) ? outline.characters : [];

const knownByType = {};
for (const e of existing) {
  const t = (e.entry_type || 'other').toLowerCase();
  (knownByType[t] = knownByType[t] || []).push(e.name);
}
const knownChars = new Set([
  ...(knownByType['character'] || []),
  ...outlineCharacters.map((c) => c.name_format || c.name).filter(Boolean),
]);
const summarise = (arr) => arr && arr.length ? arr.slice(0, 50).join(', ') : '(none)';
const knownLines = [
  `Characters already in canon: ${summarise([...knownChars])}`,
  `Locations already in canon: ${summarise(knownByType['location'])}`,
  `Items already in canon: ${summarise(knownByType['item'])}`,
  `Events already in canon: ${summarise(knownByType['event'])}`,
].join('\n');

const promptText =
  'You extract NEW story-bible entries from a chapter. Return STRICT JSON.\n\n' +
  '## ALREADY KNOWN — do NOT re-emit:\n' +
  knownLines + '\n\n' +
  '## CATEGORIES — only emit when the entity is plot-load-bearing:\n' +
  '- character: a NAMED person (not "the agent", "a guard"). Has a real name in the prose.\n' +
  '- location: a SPECIFIC place with a name (not "the office"). E.g. "Roosevelt Elementary".\n' +
  '- item: a SIGNIFICANT object that recurs or carries plot weight.\n' +
  '- event: a ONE-TIME story event that establishes canon and may be referenced later.\n\n' +
  '## RULES\n' +
  '- If the entity is in the "ALREADY KNOWN" lists above, DO NOT emit it again.\n' +
  '- Be conservative. Better to miss a borderline entry than spam the bible.\n' +
  '- Description: 1 to 2 sentences. Plain prose.\n' +
  '- Names must be the canonical form as used in this chapter.\n\n' +
  '## OUTPUT — STRICT JSON, no markdown fences\n' +
  '{ "new_story_bible_entries": [ {"entry_type": "character|location|item|event", "name": "...", "description": "..."} ] }\n\n' +
  'If there are no new entries: {"new_story_bible_entries": []}\n\n' +
  '## CHAPTER (Chapter ' + chapter.chapter_number + (chapter.title ? ' — ' + chapter.title : '') + ')\n\n' +
  (chapter.content_text || '');

return [{ json: { _extract_prompt: promptText, chapter_number: chapter.chapter_number, project_id: trig.project_id, user_id: trig.user_id } }];
"""

LOAD_PROJECT_CODE = r"""// Load project + story_bible + outline for the backfill request.
const trig = $('webhook_trigger').first().json.body || $('webhook_trigger').first().json;
const projectId = trig.project_id;
const userId = trig.user_id;
const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = { apikey: apiKey, Authorization: 'Bearer ' + apiKey };

const proj = await this.helpers.httpRequest({
  method: 'GET',
  url: supabaseUrl + '/rest/v1/writing_projects_v2?id=eq.' + encodeURIComponent(projectId)
       + '&user_id=eq.' + encodeURIComponent(userId)
       + '&select=id,title,outline',
  headers,
});
const project = Array.isArray(proj) ? proj[0] : proj;
if (!project || !project.id) throw new Error('project not found');

const bible = await this.helpers.httpRequest({
  method: 'GET',
  url: supabaseUrl + '/rest/v1/story_bible_v2?project_id=eq.' + encodeURIComponent(projectId)
       + '&deleted_at=is.null&select=id,entry_type,name,description,chapter_introduced',
  headers,
});

return [{ json: { project: { ...project, story_bible: bible } } }];
"""

LOAD_CHAPTER_CODE = r"""// Load one chapter by chapter_number from the request.
const trig = $('webhook_trigger').first().json.body || $('webhook_trigger').first().json;
const projectId = trig.project_id;
const chapterNumber = trig.chapter_number;
const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = { apikey: apiKey, Authorization: 'Bearer ' + apiKey };

const rows = await this.helpers.httpRequest({
  method: 'GET',
  url: supabaseUrl + '/rest/v1/published_content_v2?project_id=eq.' + encodeURIComponent(projectId)
       + '&content_type=eq.chapter&deleted_at=is.null'
       + '&chapter_number=eq.' + encodeURIComponent(String(chapterNumber))
       + '&select=id,chapter_number,title,content_text&limit=1',
  headers,
});
const ch = Array.isArray(rows) ? rows[0] : rows;
if (!ch) throw new Error('chapter not found: ' + chapterNumber);
return [{ json: ch }];
"""

PARSE_AND_INSERT_CODE = r"""// Parse extraction LLM output, insert rows into story_bible_v2.
const llm = $input.first().json;
const prep = $('extract_prepare').first().json;
const supabaseUrl = $('settings').first().json.SUPABASE_URL;
const apiKey = $('settings').first().json.SUPABASE_API_KEY;
const headers = { apikey: apiKey, Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };

const raw = (llm.text || llm.output || llm.response || '').toString();
let inner = raw.trim();
const fence = inner.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
if (fence) inner = fence[1].trim();
let parsed = null;
try { parsed = JSON.parse(inner); } catch (e) {
  const m = inner.match(/\{[\s\S]*\}/);
  if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
}
const newEntries = (parsed && Array.isArray(parsed.new_story_bible_entries))
  ? parsed.new_story_bible_entries.filter(e => e && e.entry_type && e.name && e.description)
  : [];

const chNum = prep.chapter_number;
const projectId = prep.project_id;
const userId = prep.user_id;
const rawCh = (chNum || '').toString().trim();
const isProl = /^(prologue|prol|0)$/i.test(rawCh);
const isEpil = /^(epilogue|epil)$/i.test(rawCh);
const chapterIntroduced = isProl ? 0 : (isEpil ? 999 : (parseInt(rawCh) || 0));

let inserted = 0;
if (newEntries.length > 0) {
  const rows = newEntries.map(e => ({
    entry_type: e.entry_type, name: e.name, description: e.description,
    project_id: projectId, user_id: userId,
    chapter_introduced: chapterIntroduced, last_chapter_seen: chapterIntroduced,
  }));
  try {
    await this.helpers.httpRequest({
      method: 'POST',
      url: supabaseUrl + '/rest/v1/story_bible_v2',
      headers,
      body: rows,
    });
    inserted = rows.length;
  } catch (e) {
    return [{ json: { error: 'insert_failed: ' + e.message, attempted: rows.length, chapter_number: chNum } }];
  }
}
return [{ json: { chapter_number: chNum, project_id: projectId, inserted, candidates: newEntries.length } }];
"""


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


def get_supabase_key_from_existing_workflow() -> str:
    # Cribbed from the deployed drift scanner's settings node.
    wf = api("GET", "/workflows/fJWDHXhle345f6jY")
    for n in wf["nodes"]:
        if n.get("name") == "settings":
            for a in n["parameters"]["assignments"]["assignments"]:
                if a["name"] == "SUPABASE_API_KEY":
                    return a["value"]
    raise RuntimeError("could not recover Supabase key from drift scanner")


def find_existing(name: str) -> str | None:
    cur = None
    while True:
        path = "/workflows?limit=250"
        if cur:
            path += "&cursor=" + cur
        r = api("GET", path)
        for wf in r.get("data", []):
            if wf.get("name") == name:
                return wf["id"]
        cur = r.get("nextCursor")
        if not cur:
            return None


def build_workflow_body(supabase_key: str) -> dict:
    nodes = [
        {
            "id": "trig",
            "name": "webhook_trigger",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [0, 0],
            "parameters": {
                "httpMethod": "POST",
                "path": WEBHOOK_PATH,
                "responseMode": "lastNode",
                "options": {},
            },
        },
        {
            "id": "set",
            "name": "settings",
            "type": "n8n-nodes-base.set",
            "typeVersion": 3.4,
            "position": [220, 0],
            "parameters": {
                "assignments": {
                    "assignments": [
                        {"id": "u", "name": "SUPABASE_URL", "value": DEV_SUPABASE_URL, "type": "string"},
                        {"id": "k", "name": "SUPABASE_API_KEY", "value": supabase_key, "type": "string"},
                    ],
                },
                "options": {},
            },
        },
        {
            "id": "lp",
            "name": "load_project",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, -100],
            "parameters": {"jsCode": LOAD_PROJECT_CODE},
        },
        {
            "id": "lc",
            "name": "load_chapter",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [660, -100],
            "parameters": {"jsCode": LOAD_CHAPTER_CODE},
        },
        {
            "id": "ep",
            "name": "extract_prepare",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [880, -100],
            "parameters": {"jsCode": PREPARE_CODE},
        },
        {
            "id": "ellm",
            "name": "extract_llm",
            "type": "@n8n/n8n-nodes-langchain.chainLlm",
            "typeVersion": 1.7,
            "position": [1100, -100],
            "parameters": {"promptType": "define", "text": "={{ $json._extract_prompt }}"},
        },
        {
            "id": "ec",
            "name": "extract_claude",
            "type": "@n8n/n8n-nodes-langchain.lmChatAnthropic",
            "typeVersion": 1.3,
            "position": [1100, 100],
            "parameters": {
                "model": {"__rl": True, "mode": "list", "value": "claude-sonnet-4-5"},
                "options": {"maxTokensToSample": 4096, "temperature": 0.2},
            },
            "credentials": {"anthropicApi": {"id": ANTHROPIC_CRED_ID, "name": "Anthropic"}},
        },
        {
            "id": "pi",
            "name": "parse_and_insert",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1320, -100],
            "parameters": {"jsCode": PARSE_AND_INSERT_CODE},
        },
    ]

    connections = {
        "webhook_trigger": {"main": [[{"node": "settings", "type": "main", "index": 0}]]},
        "settings": {"main": [[{"node": "load_project", "type": "main", "index": 0}]]},
        "load_project": {"main": [[{"node": "load_chapter", "type": "main", "index": 0}]]},
        "load_chapter": {"main": [[{"node": "extract_prepare", "type": "main", "index": 0}]]},
        "extract_prepare": {"main": [[{"node": "extract_llm", "type": "main", "index": 0}]]},
        "extract_llm": {"main": [[{"node": "parse_and_insert", "type": "main", "index": 0}]]},
        "extract_claude": {"ai_languageModel": [[{"node": "extract_llm", "type": "ai_languageModel", "index": 0}]]},
    }

    return {
        "name": WORKFLOW_NAME,
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }


def deploy_backfill_workflow(supabase_key: str) -> str:
    body = build_workflow_body(supabase_key)
    existing = find_existing(WORKFLOW_NAME)
    if existing:
        try:
            api("POST", f"/workflows/{existing}/deactivate")
        except HTTPError:
            pass
        api("PUT", f"/workflows/{existing}", body)
        try:
            api("POST", f"/workflows/{existing}/activate")
        except HTTPError:
            pass
        print(f"backfill workflow updated: {existing}")
        return existing
    created = api("POST", "/workflows", body)
    api("POST", f"/workflows/{created['id']}/activate")
    print(f"backfill workflow created: {created['id']}")
    return created["id"]


def list_chapters(project_id: str, user_id: str, supabase_key: str) -> list[int]:
    url = (
        DEV_SUPABASE_URL
        + "/rest/v1/published_content_v2?project_id=eq."
        + project_id
        + "&content_type=eq.chapter&deleted_at=is.null"
        + "&select=chapter_number&order=chapter_number"
    )
    req = Request(
        url,
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "User-Agent": UA,
        },
    )
    with urlopen(req) as resp:
        rows = json.loads(resp.read())
    return [r["chapter_number"] for r in rows]


def trigger_backfill(project_id: str, user_id: str, chapter_number: int) -> dict:
    payload = {"project_id": project_id, "user_id": user_id, "chapter_number": chapter_number}
    req = Request(
        WEBHOOK_URL,
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": UA},
        data=json.dumps(payload).encode(),
    )
    with urlopen(req, timeout=180) as resp:
        return json.loads(resp.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-id", required=True)
    ap.add_argument("--user-id", required=True)
    ap.add_argument("--only-chapter", type=int, help="optional: backfill a single chapter number")
    args = ap.parse_args()

    print("recovering Supabase key from existing drift scanner workflow...")
    sb_key = get_supabase_key_from_existing_workflow()

    print("deploying backfill workflow...")
    deploy_backfill_workflow(sb_key)
    time.sleep(2)  # let n8n register the webhook

    chapters = (
        [args.only_chapter]
        if args.only_chapter is not None
        else list_chapters(args.project_id, args.user_id, sb_key)
    )
    print(f"chapters to process: {chapters}")

    total_inserted = 0
    for cn in chapters:
        print(f"  ch {cn}: ", end="", flush=True)
        try:
            r = trigger_backfill(args.project_id, args.user_id, cn)
            inserted = r.get("inserted", 0)
            cand = r.get("candidates", 0)
            err = r.get("error")
            if err:
                print(f"ERROR: {err}")
            else:
                print(f"inserted={inserted} candidates={cand}")
                total_inserted += inserted
        except Exception as e:
            print(f"EXC: {e}")
    print(f"\nTOTAL inserted: {total_inserted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
