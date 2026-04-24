#!/usr/bin/env python3
"""
Sprint 12 S12-1: remove the rate_limit_delay and instrument Worker -
Write Chapter with end-to-end timing.

Changes on DEV Worker - Write Chapter (fsKRGkzphWT62rja):

  1. Delete the `rate_limit_delay` Wait node (120s between sub-chapters
     was defensible when n8n was rate-limiting; under BullMQ + per-user
     concurrency gating this is pure dead time).

  2. Rewire `Loop Over Sub-Chapters [main][1]` → `write_sub_chapter`
     directly. Remove rate_limit_delay's outgoing connections.

  3. Add `s12_start_ms: Date.now()` to the workflow_trigger output so
     the tail of the pipeline can compute execution_time_ms.

  4. Prepend a small timing block to the insert_draft Code node that
     reads s12_start_ms and produces a `s12_timing` object with
     started_at / finished_at / duration_ms.

S12-3 will rewrite the loop entirely for parallel fan-out; until then,
timing still flows through the sequential loop.

Replay-safe: idempotent. Detects whether each change has already been
applied.

Usage:
  N8N_API_KEY=... python3 scripts/s12-1-worker-timing.py
"""

from __future__ import annotations

import json
import os
import sys
from urllib.request import Request, urlopen

N8N_BASE = "https://n8n.agileadautomation.com"
DEV_WORKER_ID = "fsKRGkzphWT62rja"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

TIMING_BLOCK = """// --- S12-1 timing instrumentation (do not remove) ---
const _s12_start = $('workflow_trigger').first().json.s12_start_ms;
const _s12_now = Date.now();
const s12_timing = _s12_start
  ? {
      started_at: new Date(_s12_start).toISOString(),
      finished_at: new Date(_s12_now).toISOString(),
      duration_ms: _s12_now - _s12_start,
    }
  : null;
// --- end S12-1 ---
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
    keep = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"]}
    if "settings" in wf:
        keep["settings"] = wf["settings"]
    for n in keep["nodes"]:
        if "disabled" in n and not isinstance(n["disabled"], bool):
            n.pop("disabled")
    api("PUT", f"/workflows/{wf_id}", keep)


def activate(wf_id: str) -> None:
    api("POST", f"/workflows/{wf_id}/activate")


def deactivate(wf_id: str) -> None:
    api("POST", f"/workflows/{wf_id}/deactivate")


def main() -> int:
    wf = api("GET", f"/workflows/{DEV_WORKER_ID}")
    changed = False

    # 1+2. Remove rate_limit_delay node and rewire loop.
    nodes = wf["nodes"]
    before = len(nodes)
    wf["nodes"] = [n for n in nodes if n.get("name") != "rate_limit_delay"]
    if len(wf["nodes"]) != before:
        changed = True
        print(f"  Removed rate_limit_delay node ({before} -> {len(wf['nodes'])})")

    connections = wf.get("connections", {})
    if "rate_limit_delay" in connections:
        connections.pop("rate_limit_delay")
        changed = True
        print("  Removed rate_limit_delay outgoing connections")

    # Rewire Loop Over Sub-Chapters [main][1] → write_sub_chapter (if it
    # still points at rate_limit_delay).
    loop = connections.get("Loop Over Sub-Chapters") or {}
    main_outs = loop.get("main", [])
    if len(main_outs) >= 2:
        branch1 = main_outs[1] or []
        needs_rewire = any(c.get("node") == "rate_limit_delay" for c in branch1)
        if needs_rewire:
            main_outs[1] = [{"node": "write_sub_chapter", "type": "main", "index": 0}]
            changed = True
            print("  Rewired Loop Over Sub-Chapters [main][1] -> write_sub_chapter")

    # 3. Inject s12_start_ms into workflow_trigger.
    for n in wf["nodes"]:
        if n.get("name") != "workflow_trigger":
            continue
        # workflow_trigger is an executeWorkflowTrigger — it has
        # workflowInputs.value keyed by column name. Add s12_start_ms if
        # it's not already present.
        wi = n.get("parameters", {}).get("workflowInputs", {})
        val = wi.get("value", {})
        if "s12_start_ms" not in val:
            val["s12_start_ms"] = "={{ Date.now() }}"
            wi["value"] = val
            n["parameters"]["workflowInputs"] = wi
            changed = True
            print("  Added s12_start_ms to workflow_trigger output")
        break

    # 4. Inject timing block into insert_draft.
    for n in wf["nodes"]:
        if n.get("name") != "insert_draft":
            continue
        code = n["parameters"].get("jsCode", "")
        if "S12-1 timing instrumentation" not in code:
            n["parameters"]["jsCode"] = TIMING_BLOCK + "\n" + code
            changed = True
            print("  Injected S12-1 timing block into insert_draft")
        break

    if not changed:
        print("No changes needed — worker already at S12-1 state.")
        return 0

    deactivate(DEV_WORKER_ID)
    put_workflow(DEV_WORKER_ID, wf)
    activate(DEV_WORKER_ID)
    print("DEV worker updated and reactivated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
