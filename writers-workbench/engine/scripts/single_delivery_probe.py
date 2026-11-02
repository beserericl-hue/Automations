"""Live single-delivery probe (item 16): enqueue many jobs on DEV and prove each executed once.

Enqueues ``--jobs`` cheap async jobs (``library`` / ``list-outlines``, interactive queue, no email,
no LLM) with unique run_ids, plus ``--dupes`` pairs that share one caller run_id each, all at once so
both runtime replicas' workers compete for them. Then it reads the run ledger (``engine_job_runs``):

* every unique run_id has exactly one row, ``complete``, ``attempts == 1``;
* every duplicate pair has exactly one row with ``attempts == 1`` — one job executed, the other
  replayed it (``idempotent_replay``) or stood down (``duplicate_in_flight``).

A second execution of any run would show up as ``attempts > 1`` (an in-progress re-claim) or as
two "worker.write_tool.start" log lines for one run_id (check with ``railway logs --filter <tag>``).

DEV ONLY. Credentials come from the Railway environment, never from the repo::

    railway run -s writer-engine-runtime -e develop -- \\
        uv run python scripts/single_delivery_probe.py --jobs 100 --dupes 10
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from typing import Any

import httpx

PROD_MARKERS = ("faklxfakgzkpkbxfihzh", "production")


def _env(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        sys.exit(f"missing {name} (run under `railway run -s writer-engine-runtime -e develop`)")
    return v


async def _enqueue(client: httpx.AsyncClient, orch: str, secret: str, run_id: str) -> dict[str, Any]:
    r = await client.post(
        f"{orch}/pipelines/write/library/run",
        headers={"X-Service-Secret": secret},
        json={"op": "list-outlines", "limit": 1, "async": True, "run_id": run_id, "notify": False},
    )
    r.raise_for_status()
    return r.json()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=100)
    ap.add_argument("--dupes", type=int, default=10)
    ap.add_argument("--timeout", type=float, default=300.0)
    args = ap.parse_args()

    supa = _env("SUPABASE_URL").rstrip("/")
    key = _env("SUPABASE_SERVICE_ROLE_KEY")
    secret = _env("SERVICE_SHARED_SECRET")
    orch = (os.environ.get("ORCH_URL") or "https://writer-engine-runtime-develop.up.railway.app").rstrip("/")
    if any(m in supa or m in orch for m in PROD_MARKERS):
        sys.exit("refusing to run against PROD")

    tag = f"probe-{int(time.time())}"
    unique = [f"{tag}-u{i}" for i in range(args.jobs)]
    dupes = [f"{tag}-d{j}" for j in range(args.dupes)]
    async with httpx.AsyncClient(timeout=30) as client:
        submissions = unique + [d for d in dupes for _ in (0, 1)]
        started = time.monotonic()
        queued = await asyncio.gather(*(_enqueue(client, orch, secret, rid) for rid in submissions))
        print(f"enqueued {len(queued)} jobs ({args.jobs} unique + {args.dupes} duplicate pairs) tag={tag}")

        rows: list[dict[str, Any]] = []
        while time.monotonic() - started < args.timeout:
            r = await client.get(
                f"{supa}/rest/v1/engine_job_runs",
                params={"select": "run_id,status,attempts", "run_id": f"like.{tag}-*"},
                headers={"apikey": key, "Authorization": f"Bearer {key}"},
            )
            r.raise_for_status()
            rows = r.json()
            done = [x for x in rows if x["status"] == "complete"]
            if len(done) >= len(unique) + len(dupes):
                break
            await asyncio.sleep(3)

        outcomes: dict[str, int] = {}
        for q in queued:
            s = await client.get(f"{orch}/pipelines/write/jobs/{q['job_id']}", headers={"X-Service-Secret": secret})
            res = ((s.json().get("result") or {}).get("payload") or {}).get("result") or {}
            kind = (
                "duplicate_in_flight"
                if res.get("duplicate_in_flight")
                else "replay"
                if res.get("idempotent_replay")
                else f"status:{s.json().get('status')}"
            )
            outcomes[kind] = outcomes.get(kind, 0) + 1

    by_id = {x["run_id"]: x for x in rows}
    problems = []
    for rid in unique + dupes:
        row = by_id.get(rid)
        if row is None:
            problems.append(f"{rid}: no ledger row")
        elif row["status"] != "complete" or int(row["attempts"]) != 1:
            problems.append(f"{rid}: status={row['status']} attempts={row['attempts']}")
    summary = {
        "tag": tag,
        "submitted": len(unique) + 2 * len(dupes),
        "distinct_runs": len(unique) + len(dupes),
        "ledger_rows": len(rows),
        "complete": sum(1 for x in rows if x["status"] == "complete"),
        "max_attempts": max((int(x["attempts"]) for x in rows), default=0),
        "job_outcomes": outcomes,
        "elapsed_s": round(time.monotonic() - started, 1),
        "problems": problems[:20],
        "verdict": "PASS" if not problems else "FAIL",
    }
    print(json.dumps(summary, indent=2))
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
