#!/usr/bin/env python3
"""
Promote DEV workflows to PROD at release time.

This is the reverse of scripts/clone-prod-to-dev.py. For each DEV workflow
whose content has diverged from its PROD counterpart, copy DEV's nodes +
connections + settings onto the PROD workflow id, translating all
DEV-specific things back into PROD equivalents:

  - Supabase URL / service-role key: DEV project -> PROD project
  - Webhook trigger paths:     _dev -> _v2,  -dev -> -v2
  - HTTP Request /webhook/ URL path suffixes: same transform
  - executeWorkflow / toolWorkflow refs: DEV sibling id -> PROD sibling id
  - webhookIds: preserve PROD's existing webhookIds node-by-node so
    downstream consumers (ElevenLabs agent webhooks, external callers)
    keep working through the promotion

The workflow id never changes. The PROD workflow name never changes
(stays "PROD - X"). Only the internal contents change.

Safety:

  * Default is --dry-run — prints a per-workflow node diff summary; no
    API writes.
  * --apply performs the deactivate/PUT/activate cycle on PROD.
  * --only <prod_id> narrows to a single workflow (default: all mapped).
  * Every successful promotion appends an entry to
    writers-workbench/workflows/promotion-log.md with the git SHA,
    timestamp, and workflow name.

Required config (env or writers-workbench/.env):
  N8N_API_URL, N8N_API_KEY
  PROD_SUPABASE_URL, PROD_SUPABASE_SERVICE_KEY
  DEV_SUPABASE_URL,  DEV_SUPABASE_SERVICE_KEY

Exit 0 on clean dry-run or fully-applied promotion; 1 on any failure.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ID_MAP_PATH = REPO_ROOT / "scripts" / "workflow-id-map.json"
ENV_FILE = REPO_ROOT / "writers-workbench" / ".env"
LOG_PATH = REPO_ROOT / "writers-workbench" / "workflows" / "promotion-log.md"

PUT_FIELDS = ("name", "nodes", "connections", "settings")
# n8n rejects unknown settings keys on PUT
ALLOWED_SETTINGS = {
    "executionOrder", "callerPolicy", "availableInMCP",
    "saveDataErrorExecution", "saveDataSuccessExecution",
    "saveManualExecutions", "saveExecutionProgress",
    "timezone", "executionTimeout",
}


def load_env():
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

    required = [
        "N8N_API_URL", "N8N_API_KEY",
        "PROD_SUPABASE_URL", "PROD_SUPABASE_SERVICE_KEY",
        "DEV_SUPABASE_URL", "DEV_SUPABASE_SERVICE_KEY",
    ]
    missing = [k for k in required if not pick(k)]
    if missing:
        sys.exit(f"error: missing env vars: {', '.join(missing)}")
    return {
        "N8N_API_URL": pick("N8N_API_URL").rstrip("/"),
        "N8N_API_KEY": pick("N8N_API_KEY"),
        "PROD_URL": pick("PROD_SUPABASE_URL").rstrip("/"),
        "PROD_KEY": pick("PROD_SUPABASE_SERVICE_KEY"),
        "DEV_URL": pick("DEV_SUPABASE_URL").rstrip("/"),
        "DEV_KEY": pick("DEV_SUPABASE_SERVICE_KEY"),
    }


def api(cfg, method, path, body=None):
    cmd = ["curl", "-sS", "--max-time", "90", "-X", method,
           "-H", f"X-N8N-API-KEY: {cfg['N8N_API_KEY']}",
           "-H", "Accept: application/json"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json",
                "--data-binary", json.dumps(body)]
    cmd.append(f"{cfg['N8N_API_URL']}{path}")
    r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"_rc": r.returncode, "_raw": r.stdout[:300]}


def rewrite_webhook_path_to_prod(path):
    if not isinstance(path, str):
        return path
    if path.endswith("-dev"):
        return path[:-4] + "-v2"
    if path.endswith("_dev"):
        return path[:-4] + "_v2"
    return path


def translate_node_for_prod(node, cfg, dev_to_prod_ids, prod_webhook_ids_by_node_id,
                            prod_names_by_id):
    """In-place: DEV -> PROD substitutions for a single node.

    prod_webhook_ids_by_node_id: map { node.id -> prod.webhookId } so that
      when a node on DEV has an equivalent on PROD (same node.id), we
      preserve PROD's webhookId instead of shipping DEV's.
    prod_names_by_id: map { prod_workflow_id -> current PROD workflow name }
      so that executeWorkflow.cachedResultName uses PROD's real label.
    """
    params = node.get("parameters") or {}
    t = node.get("type", "")

    # Preserve PROD webhookId when the node existed on PROD under the same id
    node_id = node.get("id")
    if node.get("webhookId") and node_id in prod_webhook_ids_by_node_id:
        node["webhookId"] = prod_webhook_ids_by_node_id[node_id]

    # Webhook trigger path
    if t == "n8n-nodes-base.webhook":
        p = params.get("path")
        if isinstance(p, str):
            params["path"] = rewrite_webhook_path_to_prod(p)

    # HTTP Request URL
    if t == "n8n-nodes-base.httpRequest":
        u = params.get("url")
        if isinstance(u, str) and "/webhook/" in u:
            def repl(m):
                return "/webhook/" + rewrite_webhook_path_to_prod(m.group(1))
            params["url"] = re.sub(r"/webhook/([^/?\s]+)", repl, u)

    # executeWorkflow / toolWorkflow: rewire DEV id -> PROD id
    if t in ("n8n-nodes-base.executeWorkflow",
             "@n8n/n8n-nodes-langchain.toolWorkflow"):
        wf_ref = params.get("workflowId")
        if isinstance(wf_ref, dict):
            target_id = wf_ref.get("value")
            if target_id in dev_to_prod_ids:
                prod_id = dev_to_prod_ids[target_id]
                wf_ref["value"] = prod_id
                # Use PROD's actual current name (not a string-replace guess)
                if prod_id in prod_names_by_id:
                    wf_ref["cachedResultName"] = prod_names_by_id[prod_id]
        elif isinstance(wf_ref, str) and wf_ref in dev_to_prod_ids:
            params["workflowId"] = dev_to_prod_ids[wf_ref]


def build_prod_payload(dev_wf, prod_wf, cfg, dev_to_prod_ids, prod_names_by_id):
    """Clone DEV's nodes + connections + settings, translate to PROD."""
    # Map PROD's node.id -> webhookId so we can preserve them
    prod_webhook_ids_by_node_id = {}
    for node in prod_wf.get("nodes", []) or []:
        if node.get("id") and node.get("webhookId"):
            prod_webhook_ids_by_node_id[node["id"]] = node["webhookId"]

    # Deep copy DEV nodes via JSON round-trip, then run global string
    # substitution on the blob, then apply per-node structural rewrites.
    blob = json.dumps(dev_wf)
    blob = blob.replace(cfg["DEV_URL"], cfg["PROD_URL"])
    blob = blob.replace(cfg["DEV_KEY"], cfg["PROD_KEY"])
    translated = json.loads(blob)

    nodes = translated.get("nodes", []) or []
    for n in nodes:
        translate_node_for_prod(n, cfg, dev_to_prod_ids,
                                prod_webhook_ids_by_node_id,
                                prod_names_by_id)

    settings = translated.get("settings", {}) or {}
    stripped = {k: v for k, v in settings.items() if k in ALLOWED_SETTINGS}

    payload = {
        "name": prod_wf["name"],           # keep PROD's name
        "nodes": nodes,
        "connections": translated.get("connections", {}),
        "settings": stripped,
    }
    return payload


def payload_equals(prod_wf, payload):
    """Check whether PROD already matches the payload we'd write."""
    prod_payload = {
        "name": prod_wf.get("name"),
        "nodes": prod_wf.get("nodes", []),
        "connections": prod_wf.get("connections", {}),
        "settings": {
            k: v for k, v in (prod_wf.get("settings") or {}).items()
            if k in ALLOWED_SETTINGS
        },
    }
    return json.dumps(prod_payload, sort_keys=True) == json.dumps(payload, sort_keys=True)


def node_diff_summary(prod_wf, payload):
    """Return a short human-readable diff: node counts + first 5 changed node names."""
    old_nodes = {n.get("id"): n for n in prod_wf.get("nodes", []) or []}
    new_nodes = {n.get("id"): n for n in payload["nodes"] or []}
    added = [n for i, n in new_nodes.items() if i not in old_nodes]
    removed = [n for i, n in old_nodes.items() if i not in new_nodes]
    common = [i for i in new_nodes if i in old_nodes]

    changed = []
    for i in common:
        if json.dumps(old_nodes[i], sort_keys=True) != json.dumps(new_nodes[i], sort_keys=True):
            changed.append(new_nodes[i])

    def names(arr, n=5):
        return ", ".join((x.get("name") or x.get("id") or "?")[:40] for x in arr[:n])

    pieces = []
    if added:
        pieces.append(f"+{len(added)} [{names(added)}]")
    if removed:
        pieces.append(f"-{len(removed)} [{names(removed)}]")
    if changed:
        pieces.append(f"~{len(changed)} [{names(changed)}]")
    return "; ".join(pieces) if pieces else "(no changes)"


def current_git_sha():
    try:
        r = subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
                           capture_output=True, text=True, check=True)
        return r.stdout.strip()[:7]
    except Exception:
        return "unknown"


def append_log(entries):
    """Append a markdown block recording this promotion run."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not LOG_PATH.exists():
        LOG_PATH.write_text(
            "# DEV -> PROD Promotion Log\n\n"
            "One line per promotion run. Newest at bottom.\n\n"
        )
    sha = current_git_sha()
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    block = [f"## {ts}  (git {sha})"]
    for e in entries:
        block.append(f"- {e}")
    block.append("")
    with LOG_PATH.open("a") as f:
        f.write("\n".join(block) + "\n")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true",
                   help="actually promote (default: dry-run)")
    p.add_argument("--only", help="promote only this PROD workflow id")
    p.add_argument("--quiet", action="store_true", help="suppress no-change lines")
    args = p.parse_args()

    cfg = load_env()
    id_map_doc = json.loads(ID_MAP_PATH.read_text())
    prod_to_dev = id_map_doc["prod_to_dev"]
    dev_to_prod = {v: k for k, v in prod_to_dev.items()}

    if args.only:
        if args.only not in prod_to_dev:
            sys.exit(f"--only {args.only!r} not in id map")
        targets = {args.only: prod_to_dev[args.only]}
    else:
        targets = prod_to_dev

    # Build a prod_id -> name map upfront so we can set cachedResultName
    # to PROD's real current label during executeWorkflow rewiring.
    prod_names_by_id = {}
    for prod_id in prod_to_dev.keys():
        wf = api(cfg, "GET", f"/api/v1/workflows/{prod_id}")
        if "name" in wf:
            prod_names_by_id[prod_id] = wf["name"]

    mode = "APPLY" if args.apply else "dry-run"
    print(f"== DEV -> PROD promotion ({mode}) — {len(targets)} workflow(s) ==\n")

    log_entries = []
    applied = 0
    would_apply = 0
    no_change = 0
    errors = 0

    for prod_id, dev_id in targets.items():
        prod_wf = api(cfg, "GET", f"/api/v1/workflows/{prod_id}")
        dev_wf = api(cfg, "GET", f"/api/v1/workflows/{dev_id}")
        if "name" not in prod_wf or "name" not in dev_wf:
            print(f"  [ERR] fetch-failed  PROD={prod_id} DEV={dev_id}")
            errors += 1
            continue
        prod_name = prod_wf["name"]

        payload = build_prod_payload(dev_wf, prod_wf, cfg, dev_to_prod, prod_names_by_id)
        if payload_equals(prod_wf, payload):
            no_change += 1
            if not args.quiet:
                print(f"  [skip] no-change        {prod_name}")
            continue

        diff = node_diff_summary(prod_wf, payload)

        if not args.apply:
            print(f"  [dry ] would promote    {prod_name}")
            print(f"         diff: {diff}")
            would_apply += 1
            continue

        # --apply: deactivate -> PUT -> activate
        was_active = prod_wf.get("active", False)
        if was_active:
            r = api(cfg, "POST", f"/api/v1/workflows/{prod_id}/deactivate")
            if r.get("_rc") is not None:
                print(f"  [ERR] deactivate-failed {prod_name}: {r}")
                errors += 1
                continue
        r = api(cfg, "PUT", f"/api/v1/workflows/{prod_id}", body=payload)
        if "id" not in r:
            print(f"  [ERR] put-failed        {prod_name}: {str(r)[:150]}")
            # best-effort re-activate to avoid leaving PROD down
            if was_active:
                api(cfg, "POST", f"/api/v1/workflows/{prod_id}/activate")
            errors += 1
            continue
        if was_active:
            r = api(cfg, "POST", f"/api/v1/workflows/{prod_id}/activate")
            if r.get("active") is not True and "id" not in r:
                print(f"  [ERR] activate-failed   {prod_name}: {r}")
                errors += 1
                continue

        applied += 1
        log_entries.append(f"{prod_name}: {diff}")
        print(f"  [ok ] promoted          {prod_name}")
        time.sleep(0.2)

    print()
    if args.apply:
        print(f"applied={applied}  no-change={no_change}  errors={errors}")
        if log_entries:
            append_log(log_entries)
            print(f"log: {LOG_PATH}")
    else:
        print(f"would-apply={would_apply}  no-change={no_change}  errors={errors}")
        if would_apply:
            print("\nrun again with --apply to execute the promotion")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
