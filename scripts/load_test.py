#!/usr/bin/env python3
"""B11 — load-test the engine at N concurrent users and say what actually happened.

Gate 2's exit criterion. The inventory's premise was "we are not convinced it handles one user
correctly, let alone 50", so this measures the things the Gate 2 work claimed to fix rather than
producing a throughput number nobody can act on:

* **B4 (queue split).** Did interactive work get served while a batch of heavy work was running?
  The harness submits both at once and reports interactive latency DURING the heavy load. That is
  the whole claim: before the split, a 96-chapter write filled all 16 slots and a Q/A queued behind
  it for hours.
* **B5 (per-queue timeouts).** Did anything hit its ceiling, and was it the right ceiling?
* **B8 (provider budgets).** Did calls queue on the token/request budget, and for how long? A
  `provider_budget.stall` is the gate working; a 429 reaching a user is the gate being too loose.
* **B6 (idempotency).** Were there duplicate rows? Reported via the run ledger, not assumed.
* **B5 (DLQ).** What failed. Measured by diffing the DLQ, because a load test whose failures are
  invisible is a load test that reports success.

WAIT vs RUN is the distinction that matters and the one a naive harness loses. Total latency at 20
users is useless on its own: 60s of running is healthy, 60s of waiting for a slot is a capacity
problem, and they are the same number end to end. Each job is therefore timed in three parts —
enqueue, first seen in_progress, complete.

COST. Every op here is a real LLM call against the configured account. The default profile uses the
cheap interactive ops (a Q/A on a short chapter) precisely so 20 users can be run repeatedly for
pennies. ``--heavy N`` adds N real chapter writes, which cost real money and can each take tens of
minutes; it is opt-in and it prints what it is about to spend.

Usage::

    python3 scripts/load_test.py --users 10
    python3 scripts/load_test.py --users 20 --ops 3
    python3 scripts/load_test.py --users 20 --heavy 3        # real chapter writes, opt-in
    python3 scripts/load_test.py --users 10 --json out.json  # machine-readable

Env: ENGINE_URL (default the DEV runtime), SERVICE_SHARED_SECRET, ADMIN_TOKEN, LOAD_USER_ID.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import urllib.error
import urllib.request

DEFAULT_ENGINE = "https://writer-engine-runtime-develop.up.railway.app"

# A short, self-contained chapter so the Q/A has something real to score without a project fixture.
SAMPLE_CHAPTER = (
    "The gate held. Tayak counted three guards along the parapet and turned back into the pines, "
    "boots silent on the frost. Behind him the mound breathed its slow winter breath, and the "
    "stones at its crown caught the last of the light. He had promised the letter would cross "
    "tonight. He had not promised whose hand would carry it.\n\n"
    "By the river the ice groaned under its own weight. Tayak crouched, pressed his palm flat to "
    "it, and felt the current move beneath like something asleep and enormous. Forty paces. He had "
    "crossed worse. He had also watched a courier go through at twenty, and had not forgotten the "
    "sound."
)


@dataclass
class JobRun:
    """One submitted job, timed in the three parts that distinguish busy from backed up."""

    user: int
    tool: str
    op: str
    queue_expected: str
    job_id: str | None = None
    t_submit: float = 0.0
    t_enqueued: float = 0.0
    t_running: float | None = None
    t_done: float | None = None
    status: str = "pending"
    step_status: str | None = None
    error: str | None = None

    @property
    def enqueue_s(self) -> float:
        """How long the API took to accept the job. A user feels this one directly."""
        return self.t_enqueued - self.t_submit

    @property
    def wait_s(self) -> float | None:
        """Queued but not started — capacity. None when it was never observed running."""
        if self.t_running is None:
            return None
        return self.t_running - self.t_enqueued

    @property
    def run_s(self) -> float | None:
        if self.t_done is None:
            return None
        return self.t_done - (self.t_running or self.t_enqueued)

    @property
    def total_s(self) -> float | None:
        if self.t_done is None:
            return None
        return self.t_done - self.t_submit

    @property
    def ok(self) -> bool:
        return self.status == "complete" and self.step_status == "ok"


@dataclass
class Result:
    jobs: list[JobRun] = field(default_factory=list)
    dlq_before: int = 0
    dlq_after: list[dict[str, Any]] = field(default_factory=list)
    depth_samples: list[dict[str, Any]] = field(default_factory=list)
    started_at: float = 0.0
    ended_at: float = 0.0


def _request(url: str, *, method: str = "GET", body: Any = None, headers: dict[str, str]) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data)
    for k, v in headers.items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return {"_http_error": exc.code, **json.loads(raw)}
        except Exception:
            return {"_http_error": exc.code, "_body": raw[:300].decode(errors="replace")}
    except Exception as exc:
        return {"_error": f"{type(exc).__name__}: {exc}"}


class Engine:
    def __init__(self, base: str, secret: str, admin: str) -> None:
        self.base = base.rstrip("/")
        self._svc = {"x-service-secret": secret}
        self._adm = {"x-admin-token": admin}

    async def _call(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        # urllib is blocking; a thread per call keeps the concurrency honest without adding a dep.
        return await asyncio.to_thread(fn, *args, **kwargs)

    async def submit(self, tool: str, payload: dict[str, Any]) -> Any:
        return await self._call(
            _request,
            f"{self.base}/pipelines/write/{tool}/run",
            method="POST",
            body={**payload, "async": True},
            headers=self._svc,
        )

    async def poll(self, job_id: str) -> Any:
        return await self._call(
            _request, f"{self.base}/pipelines/write/jobs/{job_id}", headers=self._svc
        )

    async def dashboard(self) -> Any:
        return await self._call(_request, f"{self.base}/admin/dashboard", headers=self._adm)

    async def dlq(self, limit: int = 100) -> Any:
        return await self._call(_request, f"{self.base}/admin/dlq?limit={limit}", headers=self._adm)


def _plan(users: int, ops: int, heavy: int, user_id: str) -> list[JobRun]:
    """The job mix.

    Interactive ops dominate because that is the realistic shape — a user runs one chapter write and
    then pokes at Q/A, retrieval and the bible while it runs — and because it is the mix that tests
    B4's claim. Heavy jobs are added separately and deliberately.
    """
    runs: list[JobRun] = []
    for user in range(1, users + 1):
        for i in range(ops):
            if i % 2 == 0:
                runs.append(JobRun(user=user, tool="chapter", op="qa", queue_expected="engine-interactive"))
            else:
                runs.append(
                    JobRun(user=user, tool="chapter", op="scan-drift", queue_expected="engine-interactive")
                )
    for n in range(heavy):
        runs.append(JobRun(user=n + 1, tool="chapter", op="plan", queue_expected="engine-heavy"))
    return runs


def _payload(run: JobRun, user_id: str) -> dict[str, Any]:
    base: dict[str, Any] = {"op": run.op, "user_id": user_id, "chapter_number": 1}
    if run.op in {"qa", "scan-drift"}:
        base["chapter_text"] = SAMPLE_CHAPTER
    if run.op == "scan-drift":
        base["outline"] = {
            "title": "The Frozen Border",
            "premise": "A courier carries a sealed letter across a frozen border.",
            "chapters": [{"number": 1, "title": "The Crossing", "brief": "The courier reaches the river."}],
        }
    if run.op == "plan":
        base["outline"] = {
            "title": "The Frozen Border",
            "premise": "A courier carries a sealed letter across a frozen border.",
            "chapters": [{"number": 1, "title": "The Crossing", "brief": "The courier reaches the river."}],
            "characters": [{"name": "Tayak", "role": "courier"}],
        }
    return base


async def _run_one(engine: Engine, run: JobRun, user_id: str) -> None:
    run.t_submit = time.monotonic()
    resp = await engine.submit(run.tool, _payload(run, user_id))
    run.t_enqueued = time.monotonic()
    if not isinstance(resp, dict) or "job_id" not in resp:
        run.status = "submit_failed"
        run.error = json.dumps(resp)[:300]
        return
    run.job_id = str(resp["job_id"])
    queue = resp.get("queue")
    if queue and queue != run.queue_expected:
        # Not fatal, but it means the (tool, op) classification drifted from what B4 intended.
        run.error = f"routed to {queue}, expected {run.queue_expected}"
    run.status = "queued"


async def _watch(engine: Engine, runs: list[JobRun], *, timeout_s: float, interval_s: float) -> None:
    """Poll every live job until all finish or the harness times out."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        live = [r for r in runs if r.job_id and r.t_done is None and r.status != "submit_failed"]
        if not live:
            return
        results = await asyncio.gather(*[engine.poll(r.job_id or "") for r in live])
        now = time.monotonic()
        for run, body in zip(live, results, strict=False):
            if not isinstance(body, dict):
                continue
            status = str(body.get("status") or "")
            if status == "in_progress" and run.t_running is None:
                run.t_running = now
            if status in {"complete", "error", "not_found"}:
                run.t_done = now
                run.status = status
                result = body.get("result") or {}
                if isinstance(result, dict):
                    run.step_status = str(result.get("status") or "")
                    if run.step_status == "error":
                        run.error = str((result.get("error") or {}).get("message") or "")[:300]
                if status == "error":
                    # The route reports a job that RAISED as status=error with the message at the
                    # top level, not inside `result` — a job killed with its container lands here.
                    # Reading only `result` printed nine blank failures in the first mixed run and
                    # hid the Redis timeout that caused them.
                    run.error = str(body.get("error") or "worker raised, no detail")[:300]
                if status == "not_found":
                    # keep_result is well above any ceiling here, so not_found means the job was
                    # never enqueued or was dropped — worth distinguishing from a failure.
                    run.error = run.error or "job vanished (not_found)"
        await asyncio.sleep(interval_s)
    for run in runs:
        if run.t_done is None and run.job_id:
            run.status = "timeout"


async def _sample_depth(engine: Engine, result: Result, *, stop: asyncio.Event, interval_s: float) -> None:
    """Record queue depth while the load runs. The peak is the interesting part."""
    while not stop.is_set():
        body = await engine.dashboard()
        if isinstance(body, dict) and "queues" in body:
            result.depth_samples.append(
                {
                    "t": round(time.monotonic() - result.started_at, 1),
                    "status": body.get("status"),
                    "queues": {
                        name: {k: v for k, v in (q or {}).items() if k in {"depth", "running", "waiting"}}
                        for name, q in (body.get("queues") or {}).items()
                    },
                }
            )
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
        except TimeoutError:
            pass


def _pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 2)
    k = (len(ordered) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo), 2)


def _summarise(result: Result, *, users: int) -> dict[str, Any]:
    jobs = result.jobs
    by_queue: dict[str, list[JobRun]] = {}
    for job in jobs:
        by_queue.setdefault(job.queue_expected, []).append(job)

    def stats(group: list[JobRun]) -> dict[str, Any]:
        done = [j for j in group if j.total_s is not None]
        waits = [j.wait_s for j in group if j.wait_s is not None]
        runs = [j.run_s for j in group if j.run_s is not None]
        totals = [j.total_s for j in group if j.total_s is not None]
        return {
            "submitted": len(group),
            "completed": len(done),
            "ok": sum(1 for j in group if j.ok),
            "step_errors": sum(1 for j in group if j.status == "complete" and j.step_status == "error"),
            "timeouts": sum(1 for j in group if j.status == "timeout"),
            "submit_failures": sum(1 for j in group if j.status == "submit_failed"),
            "enqueue_p50_s": _pct([j.enqueue_s for j in group], 0.5),
            "enqueue_p95_s": _pct([j.enqueue_s for j in group], 0.95),
            "wait_p50_s": _pct(waits, 0.5),  # type: ignore[arg-type]
            "wait_p95_s": _pct(waits, 0.95),  # type: ignore[arg-type]
            "wait_max_s": round(max(waits), 2) if waits else None,  # type: ignore[arg-type]
            "run_p50_s": _pct(runs, 0.5),  # type: ignore[arg-type]
            "total_p50_s": _pct(totals, 0.5),  # type: ignore[arg-type]
            "total_p95_s": _pct(totals, 0.95),  # type: ignore[arg-type]
        }

    peak = {}
    for sample in result.depth_samples:
        for name, q in (sample.get("queues") or {}).items():
            prev = peak.get(name, {"depth": 0, "running": 0, "waiting": 0})
            peak[name] = {
                "depth": max(prev["depth"], q.get("depth") or 0),
                "running": max(prev["running"], q.get("running") or 0),
                "waiting": max(prev["waiting"], q.get("waiting") or 0),
            }

    new_dlq = [e for e in result.dlq_after][: max(0, len(result.dlq_after) - result.dlq_before)]
    return {
        "users": users,
        "wall_clock_s": round(result.ended_at - result.started_at, 1),
        "jobs": {"submitted": len(jobs), "ok": sum(1 for j in jobs if j.ok)},
        "per_queue": {name: stats(group) for name, group in sorted(by_queue.items())},
        "peak_queue_depth": peak,
        "misrouted": [
            {"op": j.op, "note": j.error} for j in jobs if j.error and "expected" in str(j.error)
        ],
        "new_dead_letters": len(new_dlq),
        "dead_letter_sample": new_dlq[:5],
        "errors": [
            {"op": j.op, "status": j.status, "error": (j.error or "")[:160]}
            for j in jobs
            if not j.ok and j.status != "pending"
        ][:10],
    }


def _print(summary: dict[str, Any]) -> None:
    print(f"\n=== {summary['users']} concurrent users · {summary['wall_clock_s']}s wall clock ===")
    j = summary["jobs"]
    print(f"  jobs: {j['ok']}/{j['submitted']} ok")
    for name, s in summary["per_queue"].items():
        print(f"\n  [{name}]  {s['ok']}/{s['submitted']} ok", end="")
        if s["step_errors"]:
            print(f"  ({s['step_errors']} step errors)", end="")
        if s["timeouts"]:
            print(f"  ({s['timeouts']} TIMED OUT)", end="")
        if s["submit_failures"]:
            print(f"  ({s['submit_failures']} REJECTED at submit)", end="")
        print()
        print(f"    enqueue   p50 {s['enqueue_p50_s']}s   p95 {s['enqueue_p95_s']}s")
        print(f"    QUEUE WAIT p50 {s['wait_p50_s']}s   p95 {s['wait_p95_s']}s   max {s['wait_max_s']}s")
        print(f"    run       p50 {s['run_p50_s']}s")
        print(f"    total     p50 {s['total_p50_s']}s   p95 {s['total_p95_s']}s")
    if summary["peak_queue_depth"]:
        print("\n  peak depth (depth = waiting + running):")
        for name, p in summary["peak_queue_depth"].items():
            if p["depth"]:
                print(f"    {name:22} depth {p['depth']:3}  running {p['running']:3}  waiting {p['waiting']:3}")
    if summary["misrouted"]:
        print(f"\n  !! MISROUTED: {summary['misrouted']}")
    print(f"\n  new dead letters: {summary['new_dead_letters']}")
    for entry in summary["dead_letter_sample"]:
        print(f"    {entry.get('kind')}: {str(entry.get('error'))[:120]}")
    if summary["errors"]:
        print("\n  failures:")
        for e in summary["errors"]:
            print(f"    {e['op']:12} {e['status']:12} {e['error']}")
    print()


async def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="B11 engine load test")
    ap.add_argument("--users", type=int, default=10)
    ap.add_argument("--ops", type=int, default=2, help="interactive ops per user")
    ap.add_argument("--heavy", type=int, default=0, help="real chapter PLAN jobs (costs money, slow)")
    ap.add_argument("--timeout", type=float, default=900.0, help="harness give-up, seconds")
    ap.add_argument("--poll", type=float, default=2.0)
    ap.add_argument("--json", dest="json_out", default="", help="write the summary here")
    args = ap.parse_args(argv)

    base = os.environ.get("ENGINE_URL", DEFAULT_ENGINE)
    secret = os.environ.get("SERVICE_SHARED_SECRET", "")
    admin = os.environ.get("ADMIN_TOKEN", "")
    user_id = os.environ.get("LOAD_USER_ID", "+14105914612")
    if not secret:
        print("set SERVICE_SHARED_SECRET", file=sys.stderr)
        return 2

    engine = Engine(base, secret, admin)
    runs = _plan(args.users, args.ops, args.heavy, user_id)
    print(f"engine   : {base}")
    print(f"load     : {args.users} users x {args.ops} interactive ops" + (f" + {args.heavy} heavy" if args.heavy else ""))
    print(f"jobs     : {len(runs)} (every one is a real LLM call against the configured account)")

    result = Result(started_at=time.monotonic())
    before = await engine.dlq()
    result.dlq_before = int(before.get("count", 0)) if isinstance(before, dict) else 0

    stop = asyncio.Event()
    sampler = asyncio.create_task(_sample_depth(engine, result, stop=stop, interval_s=args.poll))

    # All at once: the point is contention, not a paced ramp.
    await asyncio.gather(*[_run_one(engine, run, user_id) for run in runs])
    print(f"submitted: {sum(1 for r in runs if r.job_id)}/{len(runs)} accepted\n…polling")
    await _watch(engine, runs, timeout_s=args.timeout, interval_s=args.poll)

    stop.set()
    await sampler
    result.jobs = runs
    result.ended_at = time.monotonic()
    after = await engine.dlq()
    if isinstance(after, dict):
        result.dlq_after = list(after.get("entries") or [])

    summary = _summarise(result, users=args.users)
    _print(summary)
    if args.json_out:
        from pathlib import Path

        Path(args.json_out).write_text(json.dumps(summary, indent=2, default=str))
        print(f"  wrote {args.json_out}")
    # Non-zero when anything was lost, so this can gate a release rather than just inform one.
    lost = sum(
        s["timeouts"] + s["submit_failures"] for s in summary["per_queue"].values()
    )
    return 1 if lost else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
