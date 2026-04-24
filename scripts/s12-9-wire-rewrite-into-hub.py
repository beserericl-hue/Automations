#!/usr/bin/env python3
"""
Sprint 12 S12-9: wire DEV - Tool - Rewrite Chapter with Research
into DEV - The Author Agent (hub).

Adds a new `rewrite_chapter_with_research` toolWorkflow node to the
hub's Author Agent, connects it on the ai_tool port, and updates the
Author Agent's system prompt with a short routing block so Gemini
knows when to call it.

The tool description is the routing signal — it explicitly says:
  - "For fiction, the research grounds prose invisibly — no citations
     in prose."
  - "For non-fiction, citations go inline in prose."
  - "When the user asks to 'add research', 'ground the chapter', 'make
     X credible', 'rewrite with real facts', this is the tool."

Replay-safe: if a node named `rewrite_chapter_with_research` already
exists on the hub we update its parameters in place.

Usage:
  N8N_API_KEY=...
  REWRITE_TOOL_WF_ID=O8EWqLrqxcTJiWGN   # from s12-6
  python3 scripts/s12-9-wire-rewrite-into-hub.py
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
TOOL_NODE_NAME = "rewrite_chapter_with_research"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

TOOL_DESCRIPTION = (
    "Rewrite an EXISTING chapter so its facts, arguments, and references are grounded in "
    "real-world research, then automatically re-run the chapter Q/A pass on the fresh prose. "
    "Use this when the user asks to 'add research', 'ground the chapter', 'make it credible', "
    "'rewrite with real facts', 'check the history', or 'polish the legal argument'. You "
    "MUST call retrieve_content first if you don't yet know the exact chapter_number to rewrite. "
    "For FICTION (the default), research grounds prose invisibly — the rewritten chapter will "
    "NOT print footnote markers or source labels; research is used to make character arguments, "
    "historical references, and technical vocabulary credible. For NON-FICTION "
    "(project_type='non_fiction'), citations go inline. The research report is saved separately "
    "so the author can audit every sourced fact. After the rewrite the tool runs a fresh Q/A "
    "consistency report so the user immediately sees whether the named issues were resolved. "
    "Input chapter_number may be 'Prologue', 'Epilogue', or 1,2,3..."
)

SYSTEM_PROMPT_BLOCK = """
### REWRITE WITH RESEARCH
When the user wants an existing chapter rewritten with research grounding — phrases like "add research", "ground this chapter", "make the constitutional argument credible", "check the history", "rewrite chapter N with real facts", or "the Founding Fathers wouldn't have said that, fix it" — call `rewrite_chapter_with_research`. Pass the `chapter_number` and a 1-3 sentence `research_focus` describing WHAT to research. If the book is non-fiction the tool will surface citations in prose; if fiction it grounds the prose invisibly and preserves citations in a separate research report. Never invent citations yourself — always go through this tool.
"""

TOOL_INPUTS = [
    ("project_title", "The book project title", "string", None),
    ("chapter_number", "Chapter number (1, 2, etc.), or 'Prologue' or 'Epilogue'", "string", None),
    (
        "research_focus",
        "1-3 sentence description of what to research to ground this chapter — e.g. 'First Amendment case law on compelled speech, 1970-2005'",
        "string",
        None,
    ),
    (
        "use_qa_report",
        "If true, also feed the chapter's last QA report into the rewrite so known issues are addressed",
        "boolean",
        False,
    ),
    (
        "style_directives",
        "Optional free-text style steering, e.g. 'tighter prose, fewer adverbs'",
        "string",
        "",
    ),
    (
        "force_citations_in_prose",
        "Override: force inline citations in prose regardless of project_type. Leave empty for auto (fiction=invisible, non_fiction=inline).",
        "boolean",
        None,
    ),
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


def build_tool_node(wf_id: str) -> dict:
    def from_ai(name: str, desc: str, typ: str, default: Any) -> str:
        if default is None:
            return "={{ $fromAI('" + name + "', '" + desc.replace("'", "\\'") + "', '" + typ + "') }}"
        # 4th arg is default → optional
        dv = json.dumps(default) if isinstance(default, bool) else "'" + str(default) + "'"
        return "={{ $fromAI('" + name + "', '" + desc.replace("'", "\\'") + "', '" + typ + "', " + dv + ") }}"

    schema = []
    value = {}
    for idx, (name, desc, typ, default) in enumerate(TOOL_INPUTS, start=1):
        schema.append(
            {
                "id": f"s{idx}",
                "displayName": name,
                "required": False,
                "defaultMatch": False,
                "display": True,
                "type": typ,
                "canBeUsedToMatch": True,
            }
        )
        value[name] = from_ai(name, desc, typ, default)

    # The caller context vars the hub threads into every tool call.
    value["user_id"] = "={{ $json.body?.user_id || $json.user_id || '' }}"
    schema.append(
        {
            "id": "s_uid",
            "displayName": "user_id",
            "required": False,
            "defaultMatch": False,
            "display": True,
            "type": "string",
            "canBeUsedToMatch": True,
        }
    )

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
        "id": "tool_rewrite_research",
        "name": TOOL_NODE_NAME,
        "type": "@n8n/n8n-nodes-langchain.toolWorkflow",
        "typeVersion": 2.2,
        "position": [2400, 600],
    }


def main() -> int:
    tool_wf_id = os.environ.get("REWRITE_TOOL_WF_ID")
    if not tool_wf_id:
        print("REWRITE_TOOL_WF_ID not set", file=sys.stderr)
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
        print("  Added tool node rewrite_chapter_with_research")
    else:
        wf["nodes"][existing_idx] = tool_node
        changed = True
        print("  Updated tool node rewrite_chapter_with_research")

    # 2. Connection from tool node to Author Agent on ai_tool port.
    conns = wf.setdefault("connections", {})
    tool_conns = conns.setdefault(TOOL_NODE_NAME, {})
    if "ai_tool" not in tool_conns:
        tool_conns["ai_tool"] = [[{"node": "Author Agent", "type": "ai_tool", "index": 0}]]
        changed = True
        print("  Wired rewrite_chapter_with_research[ai_tool] -> Author Agent")

    # 3. Inject the routing block into Author Agent system message if
    #    not present.
    for n in wf["nodes"]:
        if n.get("name") == "Author Agent":
            opts = n["parameters"].setdefault("options", {})
            sys_msg = opts.get("systemMessage", "") or ""
            if "REWRITE WITH RESEARCH" not in sys_msg:
                opts["systemMessage"] = sys_msg.rstrip() + "\n\n" + SYSTEM_PROMPT_BLOCK.strip() + "\n"
                changed = True
                print("  Appended REWRITE WITH RESEARCH routing block to system prompt")
            break

    if not changed:
        print("No changes needed.")
        return 0

    # Deactivate may 403 on hub workflows; tolerate and try PUT anyway.
    try:
        api("POST", f"/workflows/{DEV_HUB_ID}/deactivate")
    except HTTPError as e:
        print(f"  deactivate returned {e.code}, continuing with PUT")

    api("PUT", f"/workflows/{DEV_HUB_ID}", clean_workflow_put_body(wf))

    # Re-activate — needed to rebuild activeVersion snapshot so the tool
    # node + system prompt changes take effect at runtime.
    try:
        api("POST", f"/workflows/{DEV_HUB_ID}/activate")
    except HTTPError as e:
        print(f"  activate returned {e.code}; workflow may already be active")
    print("DEV hub updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
