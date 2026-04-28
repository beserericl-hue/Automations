#!/usr/bin/env python3
"""S12-12: wire DEV - Tool - Scan Character Drift into the DEV hub +
extend the UI bypass sentinel to recognise ui:scan-character-drift."""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError

N8N_BASE = "https://n8n.agileadautomation.com"
DEV_HUB_ID = "FLA6xIDEvejihQLP"
TOOL_NODE_NAME = "scan_character_drift"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

TOOL_DESCRIPTION = (
    "Scan EVERY chapter of a project for character-name drift. Reads all chapters, "
    "extracts every named-person mention with surrounding context, aggregates per-character "
    "variant tallies, and surfaces drift flags against the outline character roster. "
    "Use when the user asks: 'check for character drift', 'scan for name inconsistencies', "
    "'are character names consistent across chapters', 'character canon', 'do a name audit'. "
    "Returns counts, variants_used, drift_flags (forbidden_variant / variant_inconsistency), "
    "and unknown_characters. Persists to writing_projects_v2.metadata.character_drift_scan. "
    "Does NOT modify chapters or outline — produces a report only."
)

TOOL_INPUTS = [
    ("project_title", "The book project title ONLY, exactly as stored. No surrounding quotes.", "string", None),
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
        "id": "tool_scan_drift",
        "name": TOOL_NODE_NAME,
        "type": "@n8n/n8n-nodes-langchain.toolWorkflow",
        "typeVersion": 2.2,
        "position": [2400, 1000],
    }


def patch_ui_bypass(code: str) -> tuple[str, bool]:
    if "ui:scan-character-drift" in code:
        return code, False
    candidates = [
        "_uiSource === 'ui:rewrite-with-research' || _uiSource === 'ui:evaluate-genre'",
        "_uiSource === 'ui:rewrite-with-research'",
    ]
    for needle in candidates:
        if needle in code:
            new = needle + " || _uiSource === 'ui:scan-character-drift'"
            return code.replace(needle, new), True
    return code, False


def main() -> int:
    tool_wf_id = os.environ.get("DRIFT_SCANNER_WF_ID")
    if not tool_wf_id:
        print("DRIFT_SCANNER_WF_ID not set", file=sys.stderr)
        return 2

    wf = api("GET", f"/workflows/{DEV_HUB_ID}")
    changed = False

    existing_idx = next((i for i, n in enumerate(wf["nodes"]) if n.get("name") == TOOL_NODE_NAME), None)
    tool_node = build_tool_node(tool_wf_id)
    if existing_idx is None:
        wf["nodes"].append(tool_node)
        print(f"  added tool node {TOOL_NODE_NAME}")
    else:
        wf["nodes"][existing_idx] = tool_node
        print(f"  updated tool node {TOOL_NODE_NAME}")
    changed = True

    conns = wf.setdefault("connections", {})
    tool_conns = conns.setdefault(TOOL_NODE_NAME, {})
    if "ai_tool" not in tool_conns:
        tool_conns["ai_tool"] = [[{"node": "Author Agent", "type": "ai_tool", "index": 0}]]
        print(f"  wired {TOOL_NODE_NAME}[ai_tool] -> Author Agent")

    for n in wf["nodes"]:
        if n.get("name") == "preprocess_message":
            old = n["parameters"].get("jsCode", "")
            new, did = patch_ui_bypass(old)
            if did:
                n["parameters"]["jsCode"] = new
                print("  patched preprocess_message bypass to recognise ui:scan-character-drift")
            break

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
