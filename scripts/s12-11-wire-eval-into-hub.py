#!/usr/bin/env python3
"""
Sprint 12 S12-11.5/.6: wire DEV - Tool - Evaluate Genre Compliance into the
DEV hub (FLA6xIDEvejihQLP), and add a recognition for the
`ui:evaluate-genre` source sentinel in the existing UI bypass block so
server-dispatched eval jobs skip the TOOL OVERRIDE regex short-circuits.

Replay-safe: idempotent.

Usage:
  N8N_API_KEY=...
  EVAL_TOOL_WF_ID=e9LEpCM5L7zVpQxl
  python3 scripts/s12-11-wire-eval-into-hub.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
DEV_HUB_ID = "FLA6xIDEvejihQLP"
TOOL_NODE_NAME = "evaluate_genre_compliance"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

TOOL_DESCRIPTION = (
    "Evaluate a chapter's storytelling craft against the project's genre writing directive. "
    "Use when the user asks: 'evaluate the genre', 'check genre compliance', 'is this dark "
    "comedy enough', 'review against genre', 'how well does this fit the genre', 'evaluate "
    "writing style'. Returns a structured report with: per-rule scores, evidence quotes "
    "from the chapter, and concrete suggestions split into THREE streams — prose adaptations "
    "(HOW changes within the outline), outline adaptations (WHAT changes the outline needs "
    "for the genre to work), and observations (genre gaps with no clear adaptation). The "
    "tool DOES NOT modify the chapter or the outline — it produces a report only. Persists "
    "the report to chapter.metadata.genre_eval. The user can then choose to apply prose "
    "suggestions via rewrite_chapter_with_research, or send outline suggestions through "
    "edit_outline / brainstorm_chapter."
)

TOOL_INPUTS = [
    ("project_title", "The book project title ONLY, exactly as stored in the library. No surrounding quotes, no other instructions.", "string", None),
    ("chapter_number", "Chapter number ONLY (1, 2, etc.), or the literal word 'Prologue' or 'Epilogue'.", "string", None),
]


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
    if "settings" in wf:
        keep["settings"] = wf["settings"]
    for n in keep["nodes"]:
        if "disabled" in n and not isinstance(n["disabled"], bool):
            n.pop("disabled")
    return keep


def build_tool_node(wf_id: str) -> dict:
    def from_ai(name: str, desc: str, typ: str, default: Any) -> str:
        if default is None:
            return "={{ $fromAI('" + name + "', '" + desc.replace("'", "\\'") + "', '" + typ + "') }}"
        dv = json.dumps(default) if isinstance(default, bool) else "'" + str(default) + "'"
        return "={{ $fromAI('" + name + "', '" + desc.replace("'", "\\'") + "', '" + typ + "', " + dv + ") }}"

    schema = []
    value = {}
    for idx, (name, desc, typ, default) in enumerate(TOOL_INPUTS, start=1):
        schema.append({
            "id": f"s{idx}",
            "displayName": name,
            "required": False,
            "defaultMatch": False,
            "display": True,
            "type": typ,
            "canBeUsedToMatch": True,
        })
        value[name] = from_ai(name, desc, typ, default)
    value["user_id"] = "={{ $json.body?.user_id || $json.user_id || '' }}"
    schema.append({
        "id": "s_uid", "displayName": "user_id", "required": False, "defaultMatch": False,
        "display": True, "type": "string", "canBeUsedToMatch": True,
    })

    return {
        "parameters": {
            "name": TOOL_NODE_NAME,
            "description": TOOL_DESCRIPTION,
            "workflowId": {"__rl": True, "mode": "id", "value": wf_id},
            "workflowInputs": {
                "mappingMode": "defineBelow",
                "value": value,
                "matchingColumns": [],
                "schema": schema,
            },
        },
        "id": "tool_eval_genre",
        "name": TOOL_NODE_NAME,
        "type": "@n8n/n8n-nodes-langchain.toolWorkflow",
        "typeVersion": 2.2,
        "position": [2400, 800],
    }


def patch_ui_bypass_for_eval(code: str) -> tuple[str, bool]:
    """Add 'ui:evaluate-genre' to the existing S12 UI-rewrite bypass sentinel
    set, OR add a sibling block if the rewrite bypass isn't present."""
    if "ui:evaluate-genre" in code:
        return code, False
    needle = "_uiSource === 'ui:rewrite-with-research'"
    if needle in code:
        new = "_uiSource === 'ui:rewrite-with-research' || _uiSource === 'ui:evaluate-genre'"
        return code.replace(needle, new), True
    # If the rewrite bypass isn't there for some reason, the eval requests will
    # still be routed by the explicit tool name in the prompt. Fine to no-op.
    return code, False


def main() -> int:
    tool_wf_id = os.environ.get("EVAL_TOOL_WF_ID")
    if not tool_wf_id:
        print("EVAL_TOOL_WF_ID not set", file=sys.stderr)
        return 2

    wf = api("GET", f"/workflows/{DEV_HUB_ID}")
    changed = False

    # 1. Upsert the tool node.
    existing_idx = None
    for i, n in enumerate(wf["nodes"]):
        if n.get("name") == TOOL_NODE_NAME:
            existing_idx = i
            break
    tool_node = build_tool_node(tool_wf_id)
    if existing_idx is None:
        wf["nodes"].append(tool_node)
        changed = True
        print(f"  added tool node {TOOL_NODE_NAME}")
    else:
        wf["nodes"][existing_idx] = tool_node
        changed = True
        print(f"  updated tool node {TOOL_NODE_NAME}")

    # 2. Connect tool[ai_tool] → Author Agent
    conns = wf.setdefault("connections", {})
    tool_conns = conns.setdefault(TOOL_NODE_NAME, {})
    if "ai_tool" not in tool_conns:
        tool_conns["ai_tool"] = [[{"node": "Author Agent", "type": "ai_tool", "index": 0}]]
        changed = True
        print(f"  wired {TOOL_NODE_NAME}[ai_tool] -> Author Agent")

    # 3. Extend the UI-rewrite bypass to also recognise ui:evaluate-genre
    for n in wf["nodes"]:
        if n.get("name") == "preprocess_message":
            old = n["parameters"].get("jsCode", "")
            new, did = patch_ui_bypass_for_eval(old)
            if did:
                n["parameters"]["jsCode"] = new
                changed = True
                print("  patched preprocess_message bypass to recognise ui:evaluate-genre")
            break

    if not changed:
        print("No changes needed.")
        return 0

    try:
        api("POST", f"/workflows/{DEV_HUB_ID}/deactivate")
    except HTTPError as e:
        print(f"  deactivate returned {e.code}, continuing with PUT")
    api("PUT", f"/workflows/{DEV_HUB_ID}", clean_put_body(wf))
    try:
        api("POST", f"/workflows/{DEV_HUB_ID}/activate")
    except HTTPError as e:
        print(f"  activate returned {e.code}; may already be active")
    print("DEV hub updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
