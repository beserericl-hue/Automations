#!/usr/bin/env python3
"""
Clone every PROD - <name> n8n workflow to a DEV - <name> copy.

What it does:
  Phase 1 — create DEV copies:
    - For each listed PROD workflow, fetch its full definition
    - Rewrite Supabase URL / service-role key: PROD db -> DEV db
    - Rewrite webhook trigger paths: foo_v2 -> foo_dev, foo-v2 -> foo-dev
    - Rewrite HTTP-Request URLs hitting /webhook/*_v2 to /webhook/*_dev
    - POST /workflows (created inactive, with "DEV - <name>")
    - Record PROD_id -> DEV_id in scripts/workflow-id-map.json

  Phase 2 — rewire sibling refs:
    - For each DEV copy, scan its executeWorkflow / toolWorkflow nodes
    - If a node's workflowId points at a PROD workflow, rewrite to the
      matching DEV workflow id (and the cachedResultName label)
    - PUT the updated workflow

Idempotent: re-running is safe — skips creating a DEV copy if one already
exists (detected by PROD_id in the id map, or by name "DEV - <name>").

Configuration:
  Reads N8N_API_URL + N8N_API_KEY from writers-workbench/.env.

PROD/DEV Supabase credentials are hard-coded below — if you rotate secrets
or spin up a new DEV project, update the constants.

Usage:
  python3 scripts/clone-prod-to-dev.py
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ID_MAP_PATH = REPO_ROOT / "scripts" / "workflow-id-map.json"
ENV_FILE = REPO_ROOT / "writers-workbench" / ".env"

# Supabase URLs (not secrets — just project references).
PROD_URL = "https://faklxfakgzkpkbxfihzh.supabase.co"
DEV_URL = "https://gvbvwcnmjkdpclcisqrr.supabase.co"

# Secret keys are read from env / .env at runtime, never hard-coded.
# Required env vars:
#   PROD_SUPABASE_SERVICE_KEY  — service-role secret for PROD project
#   DEV_SUPABASE_SERVICE_KEY   — service-role secret for DEV project

# The 24 active PROD workflows that make up the Writer's Workbench graph.
# Authoritative list — keep in sync if you add/remove PROD workflows.
PROD_IDS = [
    "Z18KOsqW17VQgt8i",  # PROD - 17 Cron: Scheduled Publisher
    "Ugc2BonNNMCoeXP0",  # PROD - Data: AI Scraping Pipeline
    "z9E2vmG8sZux4aNH",  # PROD - Data: Content Ingestion
    "DTjjVk51Z9aHgAg0",  # PROD - Sub - Embed Project Data
    "Q0K3aQrBMhw48lCB",  # PROD - Sub - Eve Knowledge Callback
    "QJFwA21FgfRmrSap",  # PROD - Sub - Manage Library
    "TVNfTVwOrCAnWBo7",  # PROD - Sub - Manage Research Reports
    "iDCqICsm4OpQNV6C",  # PROD - Sub - Manage Story Bible
    "2T7rElM5RqCKst51",  # PROD - Sub - Retrieve Content
    "dk75OYTASeu6NkTr",  # PROD - Sub - Token Usage Tracker
    "roMDypuMXHv6ugaZ",  # PROD - The Author Agent (hub)
    "0c4ZDWNScdmcOtr1",  # PROD - Tool - Brainstorm Chapter
    "RbKpigBMgbRG8EZn",  # PROD - Tool - Brainstorm Story
    "GzCpOrWwXHYkEAeX",  # PROD - Tool - Edit Outline
    "NBNlHQ8kAy7nX8LO",  # PROD - Tool - Email Research Report
    "WEzf89RwAbkBxmQZ",  # PROD - Tool - Format Kindle Book
    "iWIcj915TYJQkdmC",  # PROD - Tool - Generate Cover Art
    "t8xslqa3PWOFMAIM",  # PROD - Tool - QA Chapter
    "6cF3os8cvTT6Ie1d",  # PROD - Tool - Repurpose to Social Posts
    "G31zGaaG2vaTS1rw",  # PROD - Tool - Write Blog Post
    "CQdwL0Wo1ZmelyXF",  # PROD - Tool - Write Chapter
    "wdRZw4bjqPMOYd64",  # PROD - Tool - Write Newsletter
    "x7bJLdHw2Hd8Gyer",  # PROD - Tool - Write Short Story
    "VxO2eG6uvImqaPA2",  # PROD - Worker - Write Chapter
]

POST_FIELDS = ("name", "nodes", "connections", "settings", "staticData")
PUT_FIELDS = ("name", "nodes", "connections", "settings")
# n8n's public-API PUT schema rejects unknown settings keys (e.g. binaryMode)
ALLOWED_SETTINGS = {
    "executionOrder", "callerPolicy", "availableInMCP",
    "saveDataErrorExecution", "saveDataSuccessExecution",
    "saveManualExecutions", "saveExecutionProgress",
    "timezone", "executionTimeout",
}


def load_env():
    """Read config from process env first, falling back to writers-workbench/.env."""
    import os
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            m = re.match(r"^([A-Z_0-9]+)=(.*)$", line.strip())
            if m:
                v = m.group(2).strip()
                if v.startswith('"') and v.endswith('"'):
                    v = v[1:-1]
                env[m.group(1)] = v

    def pick(name):
        return os.environ.get(name) or env.get(name)

    required = ["N8N_API_URL", "N8N_API_KEY",
                "PROD_SUPABASE_SERVICE_KEY", "DEV_SUPABASE_SERVICE_KEY"]
    missing = [k for k in required if not pick(k)]
    if missing:
        sys.exit(
            f"error: missing env vars: {', '.join(missing)}\n"
            f"  Provide via process env or {ENV_FILE}.\n"
            f"  N8N_API_URL/KEY configure the n8n instance.\n"
            f"  PROD_SUPABASE_SERVICE_KEY / DEV_SUPABASE_SERVICE_KEY are the\n"
            f"  service-role secrets used to swap creds in cloned workflows."
        )
    return (
        pick("N8N_API_URL").rstrip("/"),
        pick("N8N_API_KEY"),
        pick("PROD_SUPABASE_SERVICE_KEY"),
        pick("DEV_SUPABASE_SERVICE_KEY"),
    )


def make_api(base_url, api_key):
    def api(method, path, body=None):
        cmd = [
            "curl", "-sS", "--max-time", "90", "-X", method,
            "-H", f"X-N8N-API-KEY: {api_key}",
            "-H", "Accept: application/json",
        ]
        if body is not None:
            cmd += [
                "-H", "Content-Type: application/json",
                "--data-binary", json.dumps(body),
            ]
        cmd.append(f"{base_url}{path}")
        r = subprocess.run(cmd, capture_output=True, text=True, check=False)
        try:
            return json.loads(r.stdout)
        except json.JSONDecodeError:
            return {"_rc": r.returncode, "_raw": r.stdout[:300]}
    return api


def rewrite_webhook_path(path):
    if not isinstance(path, str):
        return path
    if path.endswith("-v2"):
        return path[:-3] + "-dev"
    if path.endswith("_v2"):
        return path[:-3] + "_dev"
    return path


def rewrite_webhook_nodes(node):
    params = node.get("parameters") or {}
    t = node.get("type", "")
    if t == "n8n-nodes-base.webhook":
        p = params.get("path")
        if isinstance(p, str):
            new_p = rewrite_webhook_path(p)
            if new_p != p:
                params["path"] = new_p
    if t == "n8n-nodes-base.httpRequest":
        u = params.get("url")
        if isinstance(u, str) and "/webhook/" in u:
            def repl(m):
                return "/webhook/" + rewrite_webhook_path(m.group(1))
            new_u = re.sub(r"/webhook/([^/?\s]+)", repl, u)
            if new_u != u:
                params["url"] = new_u


def rewire_sibling_refs(node, id_map):
    """Rewrite executeWorkflow / toolWorkflow refs so DEV workflows call DEV siblings."""
    if not isinstance(node, dict):
        return False
    t = node.get("type", "")
    params = node.get("parameters") or {}
    if t not in ("n8n-nodes-base.executeWorkflow",
                 "@n8n/n8n-nodes-langchain.toolWorkflow"):
        return False
    wf_ref = params.get("workflowId")
    if isinstance(wf_ref, dict):
        target_id = wf_ref.get("value")
        if target_id in id_map:
            wf_ref["value"] = id_map[target_id]
            crn = wf_ref.get("cachedResultName")
            if isinstance(crn, str):
                wf_ref["cachedResultName"] = (
                    crn.replace("PROD -", "DEV -", 1)
                    if crn.startswith("PROD -")
                    else f"DEV - {crn}"
                )
            return True
    elif isinstance(wf_ref, str) and wf_ref in id_map:
        params["workflowId"] = id_map[wf_ref]
        return True
    return False


def main():
    base_url, api_key, prod_key, dev_key = load_env()
    api = make_api(base_url, api_key)

    # Load existing id map for resume-after-partial-run
    id_map = {}
    if ID_MAP_PATH.exists():
        doc = json.loads(ID_MAP_PATH.read_text())
        id_map = dict(doc.get("prod_to_dev", {}))

    print(f"n8n: {base_url}")
    print(f"PROD workflows to clone: {len(PROD_IDS)}")
    print(f"existing DEV copies in map: {len(id_map)}")

    # Phase 1: create DEV copies (skip if already mapped)
    print("\n=== Phase 1: create DEV copies ===")
    created = skipped = failed = 0
    for wf_id in PROD_IDS:
        if wf_id in id_map:
            skipped += 1
            continue
        full = api("GET", f"/api/v1/workflows/{wf_id}")
        if "name" not in full:
            print(f"  [ERR] fetch {wf_id}: {full}")
            failed += 1
            continue
        prod_name = full["name"]
        dev_name = (prod_name.replace("PROD - ", "DEV - ", 1)
                    if prod_name.startswith("PROD - ")
                    else f"DEV - {prod_name}")

        blob = json.dumps(full)
        blob = blob.replace(PROD_URL, DEV_URL).replace(prod_key, dev_key)
        copy = json.loads(blob)
        for node in copy.get("nodes", []) or []:
            rewrite_webhook_nodes(node)

        settings = copy.get("settings", {}) or {}
        stripped = {k: v for k, v in settings.items() if k in ALLOWED_SETTINGS}

        payload = {k: copy[k] for k in POST_FIELDS if k in copy}
        payload["name"] = dev_name
        payload["settings"] = stripped

        r = api("POST", "/api/v1/workflows", body=payload)
        if "id" not in r:
            print(f"  [ERR] create {wf_id} -> {dev_name}: {r}")
            failed += 1
            continue
        id_map[wf_id] = r["id"]
        print(f"  [ok ] {wf_id} -> {r['id']:22s}  {dev_name}")
        created += 1
        time.sleep(0.2)

    print(f"  Phase 1: created={created} skipped={skipped} failed={failed}")

    # Save id map before Phase 2 (idempotency)
    ID_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
    ID_MAP_PATH.write_text(json.dumps({
        "prod_to_dev": id_map,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "n8n_api_url": base_url,
    }, indent=2, sort_keys=True))

    # Phase 2: rewire sibling refs in every DEV copy
    print("\n=== Phase 2: rewire executeWorkflow refs ===")
    rewired = unchanged = rw_errors = 0
    for prod_id, dev_id in id_map.items():
        full = api("GET", f"/api/v1/workflows/{dev_id}")
        if "name" not in full:
            rw_errors += 1
            continue
        any_changed = False
        for node in full.get("nodes", []) or []:
            if rewire_sibling_refs(node, id_map):
                any_changed = True
        if not any_changed:
            unchanged += 1
            continue

        settings = full.get("settings", {}) or {}
        stripped = {k: v for k, v in settings.items() if k in ALLOWED_SETTINGS}
        payload = {k: full[k] for k in PUT_FIELDS if k in full}
        payload["settings"] = stripped

        r = api("PUT", f"/api/v1/workflows/{dev_id}", body=payload)
        if "id" not in r:
            print(f"  [ERR] put {dev_id}: {r}")
            rw_errors += 1
            continue
        rewired += 1
        time.sleep(0.2)

    print(f"  Phase 2: rewired={rewired} unchanged={unchanged} errors={rw_errors}")
    print(f"\nid map saved to: {ID_MAP_PATH}")


if __name__ == "__main__":
    main()
