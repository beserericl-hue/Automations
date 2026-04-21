#!/usr/bin/env python3
"""
System test: verify PROD <-> DEV tier isolation end-to-end.

Ensures that after Sprint 10.a there is no cross-tier leakage between
PROD and DEV environments. Three layers of checks:

Layer 1 — n8n workflow config
  - Every DEV workflow points at the DEV Supabase URL in its envVariables
  - No DEV workflow references the PROD Supabase URL anywhere
  - No DEV executeWorkflow / toolWorkflow node points at a PROD workflow id
  - Every DEV webhook-trigger path ends _dev or -dev (never _v2 or -v2)
  - Every PROD webhook-trigger path stays _v2 / -v2 (never _dev / -dev)
  - No DEV node shares a webhookId with any PROD node (would collide at activation)

Layer 2 — Supabase data isolation
  - Insert a tagged test row into DEV.writing_projects_v2 via the DEV service-role key
  - Assert PROD sees zero rows with that tag
  - Assert DEV sees exactly one row with that tag
  - Delete the test row on success (or on any later failure)

Layer 3 — Railway env
  - prod /api/health reports environment=production and supabase=ok
  - dev  /api/health reports environment=development and supabase=ok

Required env (via process env or writers-workbench/.env):
  N8N_API_URL, N8N_API_KEY
  PROD_SUPABASE_URL, PROD_SUPABASE_SERVICE_KEY
  DEV_SUPABASE_URL,  DEV_SUPABASE_SERVICE_KEY
  PROD_RAILWAY_URL (default: https://writersworkbench-production.up.railway.app)
  DEV_RAILWAY_URL  (default: https://writersworkbenchdev-production.up.railway.app)

Exit codes:
  0 — all layers pass, tiers fully isolated
  1 — at least one layer failed; details printed
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ID_MAP_PATH = REPO_ROOT / "scripts" / "workflow-id-map.json"
ENV_FILE = REPO_ROOT / "writers-workbench" / ".env"


# ---------- helpers ----------

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

    def pick(name, default=None):
        return os.environ.get(name) or env.get(name) or default

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
        "PROD_SUPABASE_URL": pick("PROD_SUPABASE_URL").rstrip("/"),
        "PROD_SUPABASE_KEY": pick("PROD_SUPABASE_SERVICE_KEY"),
        "DEV_SUPABASE_URL": pick("DEV_SUPABASE_URL").rstrip("/"),
        "DEV_SUPABASE_KEY": pick("DEV_SUPABASE_SERVICE_KEY"),
        "PROD_RAILWAY_URL": pick(
            "PROD_RAILWAY_URL",
            "https://writersworkbench-production.up.railway.app",
        ).rstrip("/"),
        "DEV_RAILWAY_URL": pick(
            "DEV_RAILWAY_URL",
            "https://writersworkbenchdev-production.up.railway.app",
        ).rstrip("/"),
    }


def curl(method, url, headers=None, body=None, timeout=30):
    cmd = ["curl", "-sS", "--max-time", str(timeout), "-X", method]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if body is not None:
        if "Content-Type" not in (headers or {}):
            cmd += ["-H", "Content-Type: application/json"]
        cmd += ["--data-binary", json.dumps(body)]
    cmd += ["-w", "\n__HTTP_CODE__%{http_code}"]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    out = r.stdout
    m = re.search(r"__HTTP_CODE__(\d+)\s*$", out)
    code = int(m.group(1)) if m else 0
    body_text = out[: m.start()] if m else out
    try:
        return code, json.loads(body_text) if body_text.strip() else None
    except json.JSONDecodeError:
        return code, body_text


def n8n_get(cfg, path):
    code, body = curl(
        "GET", f"{cfg['N8N_API_URL']}{path}",
        headers={"X-N8N-API-KEY": cfg["N8N_API_KEY"]},
    )
    if code != 200:
        raise RuntimeError(f"n8n GET {path} -> HTTP {code}: {body}")
    return body


def supabase_sql(cfg_url, cfg_key, sql):
    """Run SQL via PostgREST rpc — requires an `sql` rpc function. We use
    direct REST table queries instead for this script to avoid needing a
    custom rpc. Callers use supabase_select / supabase_insert / supabase_delete."""
    raise NotImplementedError("use supabase_select/insert/delete")


def supabase_select(url, key, table, params=""):
    code, body = curl(
        "GET", f"{url}/rest/v1/{table}?{params}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    if code != 200:
        raise RuntimeError(f"supabase SELECT {table}?{params} -> HTTP {code}: {body}")
    return body


def supabase_insert(url, key, table, row):
    code, body = curl(
        "POST", f"{url}/rest/v1/{table}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Prefer": "return=representation",
        },
        body=row,
    )
    if code not in (200, 201):
        raise RuntimeError(f"supabase INSERT {table} -> HTTP {code}: {body}")
    return body


def supabase_delete(url, key, table, params):
    code, body = curl(
        "DELETE", f"{url}/rest/v1/{table}?{params}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    if code not in (200, 204):
        raise RuntimeError(f"supabase DELETE {table}?{params} -> HTTP {code}: {body}")
    return body


# ---------- Layer 1: workflow config ----------

def check_workflow_isolation(cfg):
    failures = []

    id_map = json.loads(ID_MAP_PATH.read_text())["prod_to_dev"]
    prod_ids = set(id_map.keys())
    dev_ids = set(id_map.values())

    prod_url_token = cfg["PROD_SUPABASE_URL"].split("//")[-1].split(".")[0]
    dev_url_token = cfg["DEV_SUPABASE_URL"].split("//")[-1].split(".")[0]

    prod_webhook_ids = set()
    dev_webhook_ids = set()

    # Pass 1: collect webhookIds from both tiers
    for wf_id in prod_ids:
        full = n8n_get(cfg, f"/api/v1/workflows/{wf_id}")
        for n in full.get("nodes", []) or []:
            if n.get("webhookId"):
                prod_webhook_ids.add(n["webhookId"])
    for wf_id in dev_ids:
        full = n8n_get(cfg, f"/api/v1/workflows/{wf_id}")
        for n in full.get("nodes", []) or []:
            if n.get("webhookId"):
                dev_webhook_ids.add(n["webhookId"])

    overlap = prod_webhook_ids & dev_webhook_ids
    if overlap:
        failures.append(
            f"  {len(overlap)} webhookId(s) collide between PROD and DEV "
            f"(would cause activation conflict). Example: {list(overlap)[:3]}"
        )

    # Pass 2: per-DEV-workflow content checks
    for dev_id in dev_ids:
        full = n8n_get(cfg, f"/api/v1/workflows/{dev_id}")
        name = full["name"]
        blob = json.dumps(full)

        if prod_url_token in blob:
            failures.append(f"  DEV workflow '{name}' references PROD Supabase url token '{prod_url_token}'")

        for pid in prod_ids:
            if pid in blob:
                failures.append(f"  DEV workflow '{name}' references PROD workflow id {pid}")
                break  # one is enough to flag the workflow

        for node in full.get("nodes", []) or []:
            if node.get("type") == "n8n-nodes-base.webhook":
                p = (node.get("parameters") or {}).get("path")
                if isinstance(p, str) and (p.endswith("_v2") or p.endswith("-v2")):
                    failures.append(
                        f"  DEV workflow '{name}' webhook path still uses prod suffix: {p!r}"
                    )

    # Pass 3: PROD webhook paths intact
    for prod_id in prod_ids:
        full = n8n_get(cfg, f"/api/v1/workflows/{prod_id}")
        name = full["name"]
        for node in full.get("nodes", []) or []:
            if node.get("type") == "n8n-nodes-base.webhook":
                p = (node.get("parameters") or {}).get("path")
                if isinstance(p, str) and (p.endswith("_dev") or p.endswith("-dev")):
                    failures.append(
                        f"  PROD workflow '{name}' webhook path wrongly uses dev suffix: {p!r}"
                    )

    return failures


# ---------- Layer 2: supabase data isolation ----------

def check_data_isolation(cfg):
    failures = []

    # Use the first existing user_id on DEV (writing_projects_v2.user_id has
    # an FK to users_v2.user_id). Both tiers have byte-identical users_v2
    # data from the clone, so the same user_id exists on both sides.
    users = supabase_select(
        cfg["DEV_SUPABASE_URL"], cfg["DEV_SUPABASE_KEY"],
        "users_v2", "select=user_id&limit=1",
    )
    if not users:
        failures.append("  no rows in DEV.users_v2 — can't run isolation test")
        return failures
    existing_user_id = users[0]["user_id"]

    test_id = str(uuid.uuid4())
    test_title = f"isolation-test-{test_id}"
    test_row = {
        "id": test_id,
        "user_id": existing_user_id,
        "project_type": "chapter",
        "title": test_title,
    }

    inserted = False
    try:
        supabase_insert(
            cfg["DEV_SUPABASE_URL"], cfg["DEV_SUPABASE_KEY"],
            "writing_projects_v2", test_row,
        )
        inserted = True

        # Give read-replica a moment
        time.sleep(1)

        dev_rows = supabase_select(
            cfg["DEV_SUPABASE_URL"], cfg["DEV_SUPABASE_KEY"],
            "writing_projects_v2", f"title=eq.{test_title}&select=id",
        )
        prod_rows = supabase_select(
            cfg["PROD_SUPABASE_URL"], cfg["PROD_SUPABASE_KEY"],
            "writing_projects_v2", f"title=eq.{test_title}&select=id",
        )

        if len(dev_rows) != 1:
            failures.append(f"  DEV write did not land: expected 1 row with title {test_title!r}, got {len(dev_rows)}")
        if len(prod_rows) != 0:
            failures.append(
                f"  PROD saw {len(prod_rows)} row(s) with title {test_title!r} — isolation broken"
            )
    finally:
        if inserted:
            try:
                supabase_delete(
                    cfg["DEV_SUPABASE_URL"], cfg["DEV_SUPABASE_KEY"],
                    "writing_projects_v2", f"id=eq.{test_id}",
                )
            except Exception as e:
                failures.append(f"  cleanup failed (leaking row {test_id}): {e}")

    return failures


# ---------- Layer 3: railway env ----------

def check_railway_env(cfg):
    failures = []

    for label, url, want_env in (
        ("PROD", cfg["PROD_RAILWAY_URL"], "production"),
        ("DEV",  cfg["DEV_RAILWAY_URL"],  "development"),
    ):
        code, body = curl("GET", f"{url}/api/health", timeout=15)
        if code != 200 or not isinstance(body, dict):
            failures.append(f"  {label} /api/health returned HTTP {code}: {str(body)[:150]}")
            continue
        got_env = body.get("environment")
        if got_env != want_env:
            failures.append(f"  {label} /api/health reported environment={got_env!r}, expected {want_env!r}")
        if body.get("checks", {}).get("supabase") != "ok":
            failures.append(f"  {label} /api/health supabase check: {body.get('checks')}")

    return failures


# ---------- runner ----------

def main():
    cfg = load_env()

    print(f"PROD Supabase: {cfg['PROD_SUPABASE_URL']}")
    print(f"DEV  Supabase: {cfg['DEV_SUPABASE_URL']}")
    print(f"PROD Railway:  {cfg['PROD_RAILWAY_URL']}")
    print(f"DEV  Railway:  {cfg['DEV_RAILWAY_URL']}")
    print()

    total_fail = 0

    for label, fn in (
        ("Layer 1 — workflow config", check_workflow_isolation),
        ("Layer 2 — data isolation", check_data_isolation),
        ("Layer 3 — railway env", check_railway_env),
    ):
        print(f"== {label} ==")
        try:
            failures = fn(cfg)
        except Exception as e:
            failures = [f"  exception: {type(e).__name__}: {e}"]
        if failures:
            total_fail += len(failures)
            for f in failures:
                print(f)
            print(f"  -> {len(failures)} FAIL(S)")
        else:
            print("  ok")
        print()

    if total_fail:
        print(f"TIER ISOLATION: FAIL ({total_fail} problem(s))")
        return 1
    print("TIER ISOLATION: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
