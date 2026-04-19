#!/usr/bin/env python3
"""
Clone all n8n V2 tool workflows to their Dev counterparts.

Idempotent: skips workflows whose Dev counterpart already exists.

What it does:
  1. Fetches all workflows from the n8n instance.
  2. Selects V2 tool workflows — excludes Orig/V1 workflows, the hub,
     any workflow already suffixed with "Dev", and any workflow whose
     Dev counterpart (same base name + " Dev") already exists.
  3. For each selected V2 workflow, creates a new workflow with:
       - name = "<V2 name> Dev"
       - same nodes, connections, settings, credentials
       - workflow is created inactive; caller activates after rewire.
  4. After all Dev workflows are created, performs a rewire pass:
       - executeWorkflow nodes whose target is a V2 workflow are
         updated to point at the Dev counterpart (using the id map).
       - Webhook trigger paths that contain "-v2" or end with "v2"
         are rewritten with "-dev" / "dev".
       - HTTP Request nodes with URLs hitting /webhook/*-v2 are
         rewritten to hit the corresponding -dev path.
  5. Writes the V2 -> Dev id map to scripts/workflow-id-map.json.

Configuration (in this order of precedence):
  - Env vars:  N8N_API_URL, N8N_API_KEY
  - .mcp.json at repo root (reads mcpServers.n8n-mcp.env)

The hub workflow (The Author Agent_V2) is intentionally skipped — it
is cloned and rewired separately in Sprint 10.a story S10a-3.
"""

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

REPO_ROOT = Path(__file__).resolve().parent.parent
MCP_CONFIG = REPO_ROOT / ".mcp.json"
ID_MAP_PATH = REPO_ROOT / "scripts" / "workflow-id-map.json"

# Workflows to exclude from cloning (hub handled in S10a-3)
HUB_NAME_PATTERN = re.compile(r"^The Author Agent", re.IGNORECASE)
ORIG_NAME_PATTERN = re.compile(r"\bOrig\b|\bOriginal\b", re.IGNORECASE)
DEV_NAME_PATTERN = re.compile(r"\bDev\b$", re.IGNORECASE)


def load_config():
    url = os.environ.get("N8N_API_URL")
    key = os.environ.get("N8N_API_KEY")
    if url and key:
        return url, key
    if not MCP_CONFIG.exists():
        sys.exit(f"No env vars and no {MCP_CONFIG}; cannot load n8n config")
    with MCP_CONFIG.open() as f:
        data = json.load(f)
    env = data.get("mcpServers", {}).get("n8n-mcp", {}).get("env", {})
    url = url or env.get("N8N_API_URL")
    key = key or env.get("N8N_API_KEY")
    if not url or not key:
        sys.exit("N8N_API_URL / N8N_API_KEY not found in env or .mcp.json")
    return url.rstrip("/"), key


def api_request(method, url, key, body=None):
    headers = {"X-N8N-API-KEY": key, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, method=method, headers=headers)
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        sys.exit(f"HTTP {e.code} on {method} {url}:\n{body}")
    except URLError as e:
        sys.exit(f"Network error: {e}")


def list_all_workflows(base_url, key):
    """Paginate through /workflows until exhausted."""
    workflows = []
    cursor = None
    while True:
        url = f"{base_url}/api/v1/workflows?limit=250"
        if cursor:
            url += f"&cursor={cursor}"
        resp = api_request("GET", url, key)
        workflows.extend(resp.get("data", []))
        cursor = resp.get("nextCursor")
        if not cursor:
            break
    return workflows


def get_workflow(base_url, key, workflow_id):
    return api_request("GET", f"{base_url}/api/v1/workflows/{workflow_id}", key)


def create_workflow(base_url, key, workflow_body):
    return api_request("POST", f"{base_url}/api/v1/workflows", key, workflow_body)


def update_workflow(base_url, key, workflow_id, workflow_body):
    return api_request(
        "PUT", f"{base_url}/api/v1/workflows/{workflow_id}", key, workflow_body
    )


def activate_workflow(base_url, key, workflow_id):
    return api_request(
        "POST", f"{base_url}/api/v1/workflows/{workflow_id}/activate", key
    )


def deactivate_workflow(base_url, key, workflow_id):
    return api_request(
        "POST", f"{base_url}/api/v1/workflows/{workflow_id}/deactivate", key
    )


def is_v2_tool_workflow(name):
    """Select V2 tool workflows; exclude hub, Orig, and existing Dev clones."""
    if HUB_NAME_PATTERN.match(name):
        return False
    if ORIG_NAME_PATTERN.search(name):
        return False
    if DEV_NAME_PATTERN.search(name):
        return False
    # "V2" must appear somewhere in the name to qualify
    return bool(re.search(r"\bV2\b", name))


def strip_to_create_payload(workflow):
    """Extract the fields n8n expects on POST /workflows."""
    allowed = {"name", "nodes", "connections", "settings", "staticData"}
    return {k: workflow[k] for k in allowed if k in workflow}


def rewire_node(node, id_map):
    """Apply Dev-suffix rewrites to a single node in place."""
    changed = False
    node_type = node.get("type", "")
    params = node.get("parameters", {}) or {}

    # executeWorkflow: rewire workflowId to Dev counterpart if known
    if node_type == "n8n-nodes-base.executeWorkflow":
        wf_ref = params.get("workflowId")
        if isinstance(wf_ref, dict):
            target_id = wf_ref.get("value")
            if target_id in id_map:
                wf_ref["value"] = id_map[target_id]
                if "cachedResultName" in wf_ref and isinstance(
                    wf_ref.get("cachedResultName"), str
                ):
                    wf_ref["cachedResultName"] += " Dev"
                changed = True
        elif isinstance(wf_ref, str) and wf_ref in id_map:
            params["workflowId"] = id_map[wf_ref]
            changed = True

    # Webhook trigger path: v2 -> dev
    if node_type == "n8n-nodes-base.webhook":
        path = params.get("path")
        if isinstance(path, str):
            new_path = _swap_v2_dev(path)
            if new_path != path:
                params["path"] = new_path
                changed = True

    # HTTP Request targeting a -v2 webhook path
    if node_type == "n8n-nodes-base.httpRequest":
        url = params.get("url")
        if isinstance(url, str) and "/webhook/" in url:
            new_url = _swap_v2_dev_in_url(url)
            if new_url != url:
                params["url"] = new_url
                changed = True
        # n8n HTTP Request v4+ uses jsonBody/body — check common body fields
        for key in ("body", "jsonBody"):
            val = params.get(key)
            if isinstance(val, str) and "/webhook/" in val:
                new_val = _swap_v2_dev_in_url(val)
                if new_val != val:
                    params[key] = new_val
                    changed = True

    return changed


def _swap_v2_dev(path):
    """Swap -v2 / v2 suffix for -dev / dev in a webhook path fragment."""
    # "write-chapter-worker-v2" -> "write-chapter-worker-dev"
    if re.search(r"-v2$", path):
        return re.sub(r"-v2$", "-dev", path)
    # "author_request_v2" -> "author_request_dev"
    if re.search(r"_v2$", path):
        return re.sub(r"_v2$", "_dev", path)
    return path


def _swap_v2_dev_in_url(url):
    """Swap -v2 / _v2 suffix in the path segment after /webhook/."""
    # Capture segment immediately after /webhook/
    def repl(match):
        segment = match.group(1)
        return "/webhook/" + _swap_v2_dev(segment)

    return re.sub(r"/webhook/([^/?\s]+)", repl, url)


def main():
    base_url, key = load_config()
    print(f"[info] Connecting to n8n at {base_url}")

    all_wf = list_all_workflows(base_url, key)
    print(f"[info] Fetched {len(all_wf)} workflows total")

    # Index existing workflows by name
    by_name = {wf["name"]: wf for wf in all_wf}

    # Build list of V2 tool workflows to clone
    to_clone = []
    skipped_existing = []
    for wf in all_wf:
        name = wf["name"]
        if not is_v2_tool_workflow(name):
            continue
        dev_name = name + " Dev"
        if dev_name in by_name:
            skipped_existing.append(dev_name)
            continue
        to_clone.append(wf)

    print(f"[info] {len(to_clone)} V2 workflows to clone")
    print(f"[info] {len(skipped_existing)} Dev counterparts already exist (skipped)")

    # Phase 1: create Dev workflows (content unchanged)
    id_map = {}  # v2_id -> dev_id

    # Include existing Dev counterparts in the map (for re-runs after partial clone)
    for wf in all_wf:
        name = wf["name"]
        if DEV_NAME_PATTERN.search(name):
            v2_name = re.sub(r"\s+Dev$", "", name)
            v2_wf = by_name.get(v2_name)
            if v2_wf:
                id_map[v2_wf["id"]] = wf["id"]

    for v2_wf in to_clone:
        v2_id = v2_wf["id"]
        v2_name = v2_wf["name"]
        dev_name = v2_name + " Dev"
        print(f"[clone] {v2_name}")
        full = get_workflow(base_url, key, v2_id)
        payload = strip_to_create_payload(full)
        payload["name"] = dev_name
        try:
            created = create_workflow(base_url, key, payload)
        except SystemExit:
            raise
        id_map[v2_id] = created["id"]
        time.sleep(0.2)  # be polite to n8n

    # Phase 2: rewire executeWorkflow + webhook paths in Dev workflows
    print(f"[info] Rewiring {len(id_map)} Dev workflows")
    rewire_count = 0
    for v2_id, dev_id in id_map.items():
        full = get_workflow(base_url, key, dev_id)
        nodes = full.get("nodes", [])
        any_changed = False
        for node in nodes:
            if rewire_node(node, id_map):
                any_changed = True
        if any_changed:
            payload = strip_to_create_payload(full)
            # Update via PUT; n8n rejects PUT with active=true in body
            update_workflow(base_url, key, dev_id, payload)
            rewire_count += 1
            print(f"[rewire] {full['name']}")
            time.sleep(0.3)

    print(f"[info] Rewired {rewire_count} workflows")

    # Save id map
    ID_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ID_MAP_PATH.open("w") as f:
        json.dump(
            {
                "v2_to_dev": id_map,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "n8n_api_url": base_url,
            },
            f,
            indent=2,
            sort_keys=True,
        )
    print(f"[info] Wrote id map: {ID_MAP_PATH}")
    print(f"[info] Total V2 -> Dev mappings: {len(id_map)}")


if __name__ == "__main__":
    main()
