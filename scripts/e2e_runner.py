#!/usr/bin/env python3
"""E2E suite runner — drives the engine CHAT interface (and voice webhook) for one test prompt,
polls the job to completion, and dumps the raw outcome so each test's provable result can be verified.

Usage:
  E2E_SECRET=... python3 scripts/e2e_runner.py chat  "list all my outlines"
  E2E_SECRET=... python3 scripts/e2e_runner.py voice "Write me a newsletter ..."

Env:
  E2E_SECRET   — the DEV gateway SERVICE_SHARED_SECRET (64 chars)
  E2E_GATEWAY  — override gateway base URL (default: DEV public URL)
  E2E_USER     — user_id / caller_id (default +14105914612)
  E2E_TIMEOUT  — seconds to wait for an async job (default 900)
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request

GATEWAY = os.environ.get("E2E_GATEWAY", "https://writer-engine-gateway-develop.up.railway.app")
SECRET = os.environ.get("E2E_SECRET", "")
USER = os.environ.get("E2E_USER", "+14105914612")
TIMEOUT = int(os.environ.get("E2E_TIMEOUT", "900"))


def _post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{GATEWAY}{path}", data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-service-secret": SECRET}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def _get(path: str) -> dict:
    req = urllib.request.Request(f"{GATEWAY}{path}", headers={"x-service-secret": SECRET})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def run(source: str, message: str) -> dict:
    if source == "voice":
        resp = _post("/internal/hub/voice", {"user_message_request": message, "system__caller_id": USER})
    else:
        resp = _post("/internal/hub", {"message": message, "user_id": USER})
    out = {"response": resp, "job_result": None}
    job_id = resp.get("job_id")
    if job_id and resp.get("kind") == "queued":
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            time.sleep(8)
            try:
                jr = _get(f"/internal/write/jobs/{job_id}")
            except Exception as exc:  # noqa: BLE001
                jr = {"status": "poll_error", "error": str(exc)[:200]}
            st = jr.get("status")
            if st in ("complete", "error", "not_found", "failed"):
                out["job_result"] = jr
                break
            out["job_result"] = jr  # keep last seen
    return out


def _summarize(label: str, out: dict) -> str:
    r = out["response"]
    jr = out.get("job_result") or {}
    lines = [f"[{label}] kind={r.get('kind')} tool={r.get('tool')} op={r.get('op')} "
             f"job={r.get('job_id') or '-'} status={jr.get('status') or '-'}"]
    am = r.get("assistant_message") or ""
    if am:
        lines.append(f"  say: {am[:160]}")
    # surface the step result (sync data or async job result payload)
    res = ((r.get("data") or {}).get("payload") or {}).get("result")
    if res is None:
        res = (jr.get("result") or {})
        if isinstance(res, dict):
            res = (res.get("payload") or {}).get("result", res)
    if isinstance(res, dict):
        keys = ["persist", "content_id", "research_id", "emailed", "to", "subject", "invoked", "found",
                "reverted", "chapter_story_arc", "book_arc", "count", "word_count", "section_count",
                "character_consistency", "status", "title"]
        compact = {k: res.get(k) for k in keys if k in res}
        if "persist" in res and isinstance(res["persist"], dict):
            compact["persist"] = {k: res["persist"].get(k) for k in ("persisted", "content_id") if k in res["persist"]}
        if compact:
            lines.append(f"  result: {json.dumps(compact)[:400]}")
        if res.get("items") is not None:
            lines.append(f"  items: {len(res['items'])}")
        if res.get("citations"):
            lines.append(f"  citations: {len(res['citations'])}")
    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 3 or not SECRET:
        print("usage: E2E_SECRET=... e2e_runner.py <chat|voice> <message> [label]", file=sys.stderr)
        sys.exit(2)
    label = sys.argv[3] if len(sys.argv) > 3 else "test"
    out = run(sys.argv[1], sys.argv[2])
    os.makedirs("scripts/e2e_out", exist_ok=True)
    with open(f"scripts/e2e_out/{label}.json", "w") as f:
        json.dump(out, f, indent=2)
    print(_summarize(label, out))
