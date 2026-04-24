#!/usr/bin/env python3
"""
Sprint 12 S12-0: enable multi-step planning on the DEV hub agent.

Two changes on the DEV hub (FLA6xIDEvejihQLP, "DEV - The Author Agent"):

  1. Author Agent node: maxIterations 3 -> 10 so Gemini can chain tool
     calls (e.g. retrieve → research → rewrite) without timing out.

  2. preprocess_message Code node: prepend a multi-step detection block.
     When the user prompt matches a "task list", ". Then ...", "using
     that ...", or a "<verb1> ... and ... <verb2>" bridge, we return the
     input unchanged so the hub's TOOL OVERRIDE short-circuit does NOT
     force a single-tool response. This lets Gemini plan the chain.

Replay-safe: idempotent. If the multi-step block is already present the
script just re-asserts maxIterations and exits.

Usage:
  N8N_API_KEY=... python3 scripts/s12-0-hub-multistep.py
"""

from __future__ import annotations

import json
import os
import sys
from urllib.request import Request, urlopen

N8N_BASE = "https://n8n.agileadautomation.com"
DEV_HUB_ID = "FLA6xIDEvejihQLP"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

MULTISTEP_BLOCK = """// --- S12-0 multi-step detection (do not remove) ---
// Skip the TOOL OVERRIDE short-circuit when the user wants a chain of ops.
{
  const _raw = ($input.first().json.chatInput ?? $input.first().json.message ?? '').toString();
  const _multiStep =
    /\\btask\\s*[1-9]\\s*:/i.test(_raw) ||
    /\\.\\s+(then|after that|next)\\b/i.test(_raw) ||
    /\\b(using that|based on that|with that outline|with the research|using the research)\\b/i.test(_raw) ||
    /\\b(get|retrieve|pull|fetch|find|load|research|gather|look up)\\b[^.]{1,60}\\band\\b[^.]{1,60}\\b(rewrite|revise|rework|refine|write|update|edit|fix|improve|expand|change|apply|incorporate|integrate)\\b/i.test(_raw);
  if (_multiStep) return $input.all();
}
// --- end S12-0 ---
"""


def api(method: str, path: str, body: dict | None = None) -> dict:
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
    with urlopen(req) as resp:
        return json.loads(resp.read())


def put_workflow(wf_id: str, wf: dict) -> None:
    # n8n PUT rejects extra fields — strip to the whitelist.
    keep = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"]}
    if "settings" in wf:
        keep["settings"] = wf["settings"]
    # Clean disabled field (bool-only) per past bug.
    for n in keep["nodes"]:
        if "disabled" in n and not isinstance(n["disabled"], bool):
            n.pop("disabled")
    api("PUT", f"/workflows/{wf_id}", keep)


def activate(wf_id: str) -> None:
    api("POST", f"/workflows/{wf_id}/activate")


def deactivate(wf_id: str) -> None:
    api("POST", f"/workflows/{wf_id}/deactivate")


def main() -> int:
    wf = api("GET", f"/workflows/{DEV_HUB_ID}")
    changed = False
    for node in wf["nodes"]:
        if node.get("name") == "Author Agent":
            opts = node["parameters"].setdefault("options", {})
            if opts.get("maxIterations") != 10:
                opts["maxIterations"] = 10
                changed = True
                print("  Author Agent.maxIterations = 10")
        elif node.get("name") == "preprocess_message":
            code = node["parameters"].get("jsCode", "")
            if "S12-0 multi-step detection" not in code:
                node["parameters"]["jsCode"] = MULTISTEP_BLOCK + "\n" + code
                changed = True
                print("  preprocess_message: injected multi-step detection block")

    if not changed:
        print("No changes needed — hub already at S12-0 state.")
        return 0

    deactivate(DEV_HUB_ID)
    put_workflow(DEV_HUB_ID, wf)
    activate(DEV_HUB_ID)
    print("DEV hub updated and reactivated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
