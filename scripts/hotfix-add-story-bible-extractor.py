#!/usr/bin/env python3
"""
Hotfix: add story-bible extraction back into Worker - Write Chapter.

ROOT CAUSE
==========
When the chapter writer was migrated from a single-LLM architecture to
sub-chapter parallelism, each sub-chapter agent emits prose only — no
JSON envelope with `new_story_bible_entries`. The `concatenate_chapter`
Code node then hardcodes `new_story_bible_entries: []`, and the
downstream `update_story_bible` node (which DOES correctly insert into
`story_bible_v2`) sees an empty array on every chapter and inserts
nothing.

Result: any project written under the new sub-chapter architecture has
zero story bible entries, regardless of how many chapters it has. Older
projects (e.g. The Familiar, written under the V1 single-LLM era) still
have populated bibles because the original architecture emitted entries
in the same response as the chapter prose.

FIX
===
Insert two new nodes between `continuity_finalize` and `update_story_bible`:

1. `extract_bible_prepare` — Code node that builds an LLM prompt:
   reads existing story bible + outline characters, the finalised chapter
   text, and instructs Claude to emit ONLY new entries not already known.

2. `extract_bible_llm` — chainLlm + `extract_bible_claude` (Sonnet 4.5),
   produces JSON `{"new_story_bible_entries": [...]}` which is merged
   into `output` and passed to `update_story_bible` unchanged.

The downstream `update_story_bible` Code node already reads
`$input.first().json.output.new_story_bible_entries` and inserts rows.
With this fix, that array is now populated by the new extraction node
instead of by sub-chapter writers.

USAGE
=====
- Default target: DEV - Worker - Write Chapter (`fsKRGkzphWT62rja`)
- Pass `--target prod` to mirror the change to PROD - Worker - Write Chapter
  (id resolved via workflow-id-map.json) for the post-DEV-validation hotfix.

  N8N_API_KEY=...  python3 scripts/hotfix-add-story-bible-extractor.py
  N8N_API_KEY=...  python3 scripts/hotfix-add-story-bible-extractor.py --target prod

Idempotent: detects existing extraction nodes and re-applies the connection
graph rather than duplicating.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

DEV_WORKER_ID = "fsKRGkzphWT62rja"
PROD_WORKER_ID = "VxO2eG6uvImqaPA2"  # PROD - Worker - Write Chapter (verified via workflow-id-map.json)
ANTHROPIC_CRED_ID = "5LhCYKsaFO3fF7II"  # shared between DEV + PROD per MEMORY.md

EXTRACT_PREPARE_CODE = r"""// hotfix: build the prompt that extracts NEW story-bible entries from the
// finalised chapter text. Reads existing entries + outline so we don't
// duplicate already-known characters/places/items/events. Outputs the
// finalised chapter envelope unchanged plus a new `_extract_prompt`
// field that the chainLlm node consumes.

const upstream = $input.first().json;
const outerOutput = upstream.output || {};
const chapterText = outerOutput.chapter_text || '';
const chapterTitle = outerOutput.chapter_title || '';

const projectData = $('get_project_data').first().json || {};
const existing = Array.isArray(projectData.story_bible) ? projectData.story_bible : [];
const outline = projectData.outline || {};
const outlineCharacters = Array.isArray(outline.characters) ? outline.characters : [];

const rawCh = ($('workflow_trigger').first().json.chapter_number || '').toString().trim();
const isProl = /^(prologue|prol|0)$/i.test(rawCh);
const isEpil = /^(epilogue|epil)$/i.test(rawCh);
const chapterNum = isProl ? 0 : (isEpil ? 999 : (parseInt(rawCh) || 0));

// Build do-not-emit lists
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
  '- location: a SPECIFIC place with a name (not "the office", "the bar"). E.g. "Roosevelt Elementary", "Carcassonne".\n' +
  '- item: a SIGNIFICANT object that recurs or carries plot weight (a locket, a manuscript, a weapon). Skip generic objects.\n' +
  '- event: a ONE-TIME story event that establishes canon and may be referenced later (an execution, a wedding, a murder, a trial).\n\n' +
  '## RULES\n' +
  '- If the entity is in the "ALREADY KNOWN" lists above, DO NOT emit it again.\n' +
  '- Be conservative. When in doubt, do not emit. Better to miss a borderline entry than spam the bible.\n' +
  '- Description: 1 to 2 sentences. Plain prose.\n' +
  '- Names must be the canonical form as used in this chapter (full name for characters; full place name for locations).\n\n' +
  '## OUTPUT — STRICT JSON, no markdown fences\n' +
  '{\n' +
  '  "new_story_bible_entries": [\n' +
  '    {"entry_type": "character|location|item|event", "name": "...", "description": "..."}\n' +
  '  ]\n' +
  '}\n\n' +
  'If there are no new entries: {"new_story_bible_entries": []}\n\n' +
  '## CHAPTER (Chapter ' + chapterNum + (chapterTitle ? ' — ' + chapterTitle : '') + ')\n\n' +
  chapterText;

return [{
  json: {
    ...upstream,
    output: outerOutput,
    _extract_prompt: promptText,
  },
}];
"""

EXTRACT_FINALIZE_CODE = r"""// hotfix: parse the bible-extraction LLM output and merge
// new_story_bible_entries onto the chapter envelope expected by
// update_story_bible. Defensive: tolerate code fences, malformed JSON,
// and missing fields. Never throw — story-bible enrichment must not
// fail the chapter write.

const llm = $input.first().json;
const upstream = $('extract_bible_prepare').first().json;
const outerOutput = upstream.output || {};
const raw = (llm.text || llm.output || llm.response || '').toString();

let inner = raw.trim();
const fence = inner.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
if (fence) inner = fence[1].trim();

let parsed = null;
try {
  parsed = JSON.parse(inner);
} catch (e) {
  // try to extract first {...} block
  const m = inner.match(/\{[\s\S]*\}/);
  if (m) {
    try { parsed = JSON.parse(m[0]); } catch (_) {}
  }
}

const newEntries = (parsed && Array.isArray(parsed.new_story_bible_entries))
  ? parsed.new_story_bible_entries.filter(
      (e) => e && e.entry_type && e.name && e.description
    )
  : [];

return [{
  json: {
    ...upstream,
    output: { ...outerOutput, new_story_bible_entries: newEntries },
    _extract_count: newEntries.length,
  },
}];
"""


# -----------------------------------------------------------------------------

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
        print(f"  HTTP {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        raise


def clean_put_body(wf: dict) -> dict:
    keep = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"]}
    # n8n's PUT validator rejects nearly every settings key. Per
    # 2026-04-21 SESSION_CONTEXT note: "settings itself only allows a
    # small allowlist — binaryMode, callerPolicy, availableInMCP etc.
    # get rejected". Empirically only `executionOrder` is reliably
    # accepted on this n8n version. n8n preserves the existing settings
    # for keys not in the body, so it's safe to send a minimal object.
    keep["settings"] = {"executionOrder": "v1"}
    for n in keep["nodes"]:
        if "disabled" in n and not isinstance(n["disabled"], bool):
            n.pop("disabled")
    return keep


def patch_worker(wf_id: str) -> int:
    wf = api("GET", f"/workflows/{wf_id}")
    print(f"Workflow: {wf['name']} ({wf_id})  active={wf.get('active')}")

    nodes = wf["nodes"]
    by_name = {n["name"]: n for n in nodes}

    # Anchor node positions off continuity_finalize so the new chain sits
    # cleanly between continuity_finalize and update_story_bible.
    cf = by_name.get("continuity_finalize")
    if not cf:
        print("ERROR: continuity_finalize node missing — wrong workflow?", file=sys.stderr)
        return 2
    cx, cy = cf.get("position", [2520, -96])
    base_x = cx + 220

    new_nodes = [
        {
            "id": "extract_bible_prepare",
            "name": "extract_bible_prepare",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [base_x, cy],
            "parameters": {"jsCode": EXTRACT_PREPARE_CODE},
        },
        {
            "id": "extract_bible_llm",
            "name": "extract_bible_llm",
            "type": "@n8n/n8n-nodes-langchain.chainLlm",
            "typeVersion": 1.7,
            "position": [base_x + 220, cy],
            "parameters": {
                "promptType": "define",
                "text": "={{ $json._extract_prompt }}",
            },
        },
        {
            "id": "extract_bible_claude",
            "name": "extract_bible_claude",
            "type": "@n8n/n8n-nodes-langchain.lmChatAnthropic",
            "typeVersion": 1.3,
            "position": [base_x + 220, cy + 200],
            "parameters": {
                "model": {"__rl": True, "mode": "list", "value": "claude-sonnet-4-5"},
                "options": {"maxTokensToSample": 4096, "temperature": 0.2},
            },
            "credentials": {"anthropicApi": {"id": ANTHROPIC_CRED_ID, "name": "Anthropic"}},
        },
        {
            "id": "extract_bible_finalize",
            "name": "extract_bible_finalize",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [base_x + 440, cy],
            "parameters": {"jsCode": EXTRACT_FINALIZE_CODE},
        },
    ]

    # Idempotent upsert
    for nn in new_nodes:
        existing_idx = next((i for i, n in enumerate(nodes) if n["name"] == nn["name"]), None)
        if existing_idx is None:
            nodes.append(nn)
            print(f"  + added node {nn['name']}")
        else:
            nodes[existing_idx] = {**nodes[existing_idx], **nn}
            print(f"  ~ updated node {nn['name']}")

    # Rewire connections:
    #   continuity_finalize -> extract_bible_prepare -> extract_bible_llm -> extract_bible_finalize -> update_story_bible
    #   extract_bible_claude (ai_languageModel) -> extract_bible_llm
    conns = wf.setdefault("connections", {})

    conns["continuity_finalize"] = {
        "main": [[{"node": "extract_bible_prepare", "type": "main", "index": 0}]]
    }
    conns["extract_bible_prepare"] = {
        "main": [[{"node": "extract_bible_llm", "type": "main", "index": 0}]]
    }
    conns["extract_bible_llm"] = {
        "main": [[{"node": "extract_bible_finalize", "type": "main", "index": 0}]]
    }
    conns["extract_bible_finalize"] = {
        "main": [[{"node": "update_story_bible", "type": "main", "index": 0}]]
    }
    conns["extract_bible_claude"] = {
        "ai_languageModel": [[{"node": "extract_bible_llm", "type": "ai_languageModel", "index": 0}]]
    }
    print("  rewired continuity_finalize → extract_bible_* chain → update_story_bible")

    # Deploy
    try:
        api("POST", f"/workflows/{wf_id}/deactivate")
    except HTTPError as e:
        print(f"  deactivate {e.code}, continuing")
    api("PUT", f"/workflows/{wf_id}", clean_put_body(wf))
    try:
        api("POST", f"/workflows/{wf_id}/activate")
    except HTTPError as e:
        print(f"  activate {e.code}, may already be active")
    print(f"{wf['name']}: {wf_id} (active)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["dev", "prod"], default="dev")
    args = ap.parse_args()
    wf_id = DEV_WORKER_ID if args.target == "dev" else PROD_WORKER_ID
    if args.target == "prod":
        confirm = os.environ.get("CONFIRM_PROD") == "yes"
        if not confirm:
            print("Refusing to patch PROD without CONFIRM_PROD=yes in env.", file=sys.stderr)
            return 2
    return patch_worker(wf_id)


if __name__ == "__main__":
    sys.exit(main())
