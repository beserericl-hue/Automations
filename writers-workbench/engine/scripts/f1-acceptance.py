#!/usr/bin/env python
"""F1-7.5 acceptance-gate runner — the gate before any PROD flip (docs/f1b-hub-routing.md §4).

Automates the machine-checkable parts of the acceptance suite and prints a consolidated verdict:

  A1  Unit          — the full pytest suite is green (engine CI on develop).
  A2  System        — each write tool answers through the deployed DEV gateway (smoke per tool).
  A3  Regression    — scripts/f1a-chapter-regression.py: real DEV chapters clear craft-QA >= bar.
  A4  Parity        — mean parity over the shadow window >= 0.95 (reads a shadow-scores JSON;
                      writer_engine.parity does the scoring during the shadow run).

  A5  UAT           — a human runs each tool through the DEV Workbench UI. NOT automatable; this
                      runner prints it as a manual checklist and never marks it auto-passed.

PROD flip stays gated on (a) A1-A5 all pass on DEV AND (b) explicit user go — this script reports,
it never flips anything.

    .venv/bin/python scripts/f1-acceptance.py \
        --gateway https://writer-engine-gateway-develop.up.railway.app \
        --service-secret "$SERVICE_SECRET" --shadow-scores shadow.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

from writer_engine.parity import shadow_summary

WRITE_TOOLS = ["chapter", "research", "brainstorm", "media", "library", "story_bible", "approval", "notify"]


def a1_unit() -> dict:
    """Run the pytest suite; pass = exit 0."""
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
    )
    tail = (proc.stdout or proc.stderr).strip().splitlines()[-1:] or [""]
    return {"name": "A1 unit", "pass": proc.returncode == 0, "detail": tail[0]}


def a2_system(gateway: str, secret: str) -> dict:
    """Smoke each write tool through the deployed gateway with a cheap no-op op."""
    if not gateway or not secret:
        return {"name": "A2 system", "pass": None, "detail": "skipped (no --gateway/--service-secret)"}
    results = {}
    for tool in WRITE_TOOLS:
        body = json.dumps({"op": "__healthcheck__"}).encode()
        req = urllib.request.Request(
            f"{gateway.rstrip('/')}/internal/write/{tool}",
            data=body, method="POST",
            headers={"X-Service-Secret": secret, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                results[tool] = r.status in (200, 400)  # 400 = reached the step (unknown op) = wired
        except urllib.error.HTTPError as e:
            results[tool] = e.code in (400, 422)  # reached the step
        except Exception:
            results[tool] = False
    ok = all(results.values())
    return {"name": "A2 system", "pass": ok, "detail": results}


def a3_regression(min_score: float) -> dict:
    """Defer to the existing R-CHAPTER-DB harness (needs SUPABASE_*/ANTHROPIC_API_KEY in env)."""
    script = Path(__file__).resolve().parent / "f1a-chapter-regression.py"
    if not script.exists():
        return {"name": "A3 regression", "pass": None, "detail": "harness missing"}
    proc = subprocess.run(
        [sys.executable, str(script), "--limit", "6", "--min-score", str(min_score)],
        capture_output=True, text=True,
    )
    return {"name": "A3 regression", "pass": proc.returncode == 0,
            "detail": (proc.stdout or proc.stderr).strip().splitlines()[-1:] or [""]}


def a4_parity(shadow_scores_path: str | None) -> dict:
    if not shadow_scores_path or not Path(shadow_scores_path).exists():
        return {"name": "A4 parity", "pass": None,
                "detail": "skipped (no --shadow-scores; needs the >=7-day DEV shadow window)"}
    scores = json.loads(Path(shadow_scores_path).read_text())
    summ = shadow_summary(scores if isinstance(scores, list) else scores.get("scores", []))
    return {"name": "A4 parity", "pass": summ["passes_A4"], "detail": summ}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gateway", default="")
    ap.add_argument("--service-secret", default="")
    ap.add_argument("--shadow-scores", default="")
    ap.add_argument("--min-score", type=float, default=0.8)
    args = ap.parse_args()

    checks = [
        a1_unit(),
        a2_system(args.gateway, args.service_secret),
        a3_regression(args.min_score),
        a4_parity(args.shadow_scores),
    ]
    print("\n=== F1-7.5 ACCEPTANCE GATE (DEV) ===")
    for c in checks:
        mark = {True: "PASS", False: "FAIL", None: "SKIP"}[c["pass"]]
        print(f"  [{mark}] {c['name']}: {c['detail']}")
    print("  [MANUAL] A5 UAT: run each tool through the DEV Workbench UI end-to-end and sign off.")

    decided = [c for c in checks if c["pass"] is not None]
    auto_ok = all(c["pass"] for c in decided)
    print(
        f"\nAutomatable A1-A4: {'ALL PASS' if auto_ok else 'NOT ALL PASS'} "
        f"({sum(c['pass'] is True for c in checks)}/{len(decided)} decided). "
        "PROD flip still requires A5 UAT + explicit user go.\n"
    )
    return 0 if auto_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
