#!/usr/bin/env python3
"""Run a batch of E2E manifest tests sequentially (dependency order) through the engine chat/voice
interface, writing each full result to scripts/e2e_out/<id>.json and printing a compact summary +
a routing-match verdict (does the live route match the suite's expected route?).

Usage:  E2E_SECRET=... python3 scripts/e2e_run_batch.py R02 R03 R04 R05
        E2E_SECRET=... python3 scripts/e2e_run_batch.py --range R06 R15
"""
from __future__ import annotations

import json
import os
import sys

from e2e_runner import _summarize, run  # same dir

MANIFEST = json.load(open("scripts/e2e_out/manifest.json"))
BY_ID = {t["id"]: t for t in MANIFEST}


def _expected_route(t: dict) -> str:
    # "research.run` (task)" / "`chapter.newsletter` (task) ..." -> "research.run"
    r = t.get("route", "")
    r = r.replace("`", " ").split("(")[0]
    m = [tok for tok in r.replace("/", " ").split() if "." in tok]
    return m[0] if m else ""


def _verdict(t: dict, out: dict) -> str:
    resp = out["response"]
    jr = out.get("job_result") or {}
    exp = _expected_route(t)
    got = f"{resp.get('tool')}.{resp.get('op')}" if resp.get("tool") else resp.get("kind")
    route_ok = (exp == got) or (exp and resp.get("op") and exp.endswith(resp.get("op", "")))
    job_ok = True
    if resp.get("kind") == "queued":
        job_ok = jr.get("status") == "complete"
    flags = []
    flags.append("route✓" if route_ok else f"route✗(exp {exp}, got {got})")
    if resp.get("kind") == "queued":
        flags.append("job✓" if job_ok else f"job✗({jr.get('status')})")
    return " ".join(flags)


def main(ids: list[str]) -> None:
    for tid in ids:
        t = BY_ID.get(tid)
        if not t or not t["prompt"]:
            print(f"[{tid}] SKIP (no prompt / multi-step — run manually)")
            continue
        out = run(t["source"], t["prompt"])
        os.makedirs("scripts/e2e_out", exist_ok=True)
        with open(f"scripts/e2e_out/{tid}.json", "w") as f:
            json.dump({"test": t, **out}, f, indent=2)
        print(_summarize(tid, out))
        print(f"  VERDICT {_verdict(t, out)}  | {t['title']} ({t['source']})")
        print(f"  expected: {' | '.join(t['expected'][:6])}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--range":
        ids_all = [t["id"] for t in MANIFEST]
        i, j = ids_all.index(args[1]), ids_all.index(args[2])
        args = ids_all[i:j + 1]
    main(args)
