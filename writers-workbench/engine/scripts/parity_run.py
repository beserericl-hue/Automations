#!/usr/bin/env python
"""L5 parity harness CLI (H3) — produce engine/baseline pairs over a corpus and score them.

The >=0.95 L5 parity gate is the stated precondition for every PROD cutover
([[engine-framework-sprints]] F1-7.5 / A4) and had never been measured, because the scoring existed
(``writer_engine.parity``) but nothing produced the pairs. This is that missing piece.

Three modes, because "the baseline" means something different depending on what you are asking:

``recorded``
    Score engine artifacts against stored n8n-era artifacts on disk. What is runnable today without
    spending money or waiting on live generations. NOTE the caveat it prints: unless the two
    directories are the same project/chapters, this measures *structural* parity (does the engine
    produce artifacts of the same shape and magnitude n8n did) and NOT same-input parity. Real
    number, narrower claim.

``ab``
    Score engine-vs-engine: artifacts produced before a change against artifacts produced after it.
    This is the mode that makes a prompt or retrieval change (A2, A3) measurable, since both sides
    come from the same system on the same inputs.

``live``
    Call the deployed engine and the n8n baseline webhook for each case. The real A4 shape —
    same input, both systems — and the expensive one (real LLM spend, minutes per chapter). This is
    what the 7-day DEV shadow window should drive.

Usage::

    # structural parity of engine chapters vs recorded n8n-era chapters
    uv run python scripts/parity_run.py recorded \\
        --engine-dir  "<vault>/Workbench-Test-Output-7/chapters" \\
        --baseline-dir "<vault>/Workbench-Test-Output-3/outputs" \\
        --tool chapter --out parity_out

    # before/after a prompt change
    uv run python scripts/parity_run.py ab --before before_dir --after after_dir --tool newsletter
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from writer_engine.parity import ParityCase, render_report, run_corpus

# Scene-break conventions the chapter writers emit between sub-chapters. Counting these is a PROXY
# for sub_chapter_count when all we have is the rendered markdown (the structured count lives in the
# step's response, which recorded artifacts do not carry).
_STRUCTURAL_CAVEAT = (
    "STRUCTURAL parity only — NOT same-input. The engine and baseline artifacts were not asserted "
    "to come from the same inputs, so this measures whether the engine produces artifacts of the "
    "same shape and magnitude as n8n, not that it agrees with n8n on a given input. Also note "
    "`sub_chapter_count` is PROXY-derived from markdown scene breaks here (the structured count "
    "lives in the step response, which recorded artifacts do not carry), so divergence on that "
    "check may be measurement rather than behaviour. The A4 gate needs `live`/shadow mode."
)

_SCENE_BREAK = re.compile(r"^\s*(\*\s*\*\s*\*|---|\*\*\*|###\s)", re.M)
_FRONTMATTER = re.compile(r"\A---\n.*?\n---\n", re.S)


# Some recorded artifacts are annotated TEST REPORTS, not raw chapters: the n8n-era
# Workbench-Test-Output-* files wrap the prose in research/QA/craft sections and put the chapter
# itself under a "## Full text" heading. Scoring the whole document against raw engine prose compares
# two different kinds of thing, so extract the body when that marker is present.
_FULL_TEXT = re.compile(r"^##\s+Full text\s*$(.*?)(?=^##\s+|\Z)", re.M | re.S)


# The engine-era captures have their own annotation shape: an H1 title, a "> **drift report:** ..."
# blockquote, then a `---` rule, then the prose. Stripping that preamble matters a lot: left in, the
# separator rule itself counts as a scene break, so EVERY chapter scores sub_chapter_count == 2 and
# the metric measures the capture format rather than the prose.
_DRIFT_PREAMBLE = re.compile(r"\A\s*(#\s[^\n]*\n)?\s*(>[^\n]*\n)+\s*-{3,}\s*\n", re.M)


def chapter_body(markdown: str) -> str:
    """The chapter prose, with test-harness annotation stripped.

    Recorded artifacts are annotated captures, not raw step output, and the two eras annotate
    differently: n8n-era files wrap the prose under a ``## Full text`` heading after
    research/QA/craft sections; engine-era files prefix a drift-report blockquote and a rule. Both
    must be removed or the comparison is between capture formats.
    """
    m = _FULL_TEXT.search(markdown)
    body = m.group(1) if m else markdown
    return _DRIFT_PREAMBLE.sub("", body).strip()


def chapter_artifact(path: Path) -> dict[str, Any]:
    """Derive the fields ``parity_score`` checks for ``tool="chapter"`` from a markdown file."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    body = chapter_body(_FRONTMATTER.sub("", raw))
    breaks = len(_SCENE_BREAK.findall(body))
    return {
        "content_text": body.strip(),
        "word_count": len(body.split()),
        # +1: N scene breaks delimit N+1 sub-chapters.
        "sub_chapter_count": breaks + 1 if breaks else 1,
    }


def json_artifact(path: Path) -> dict[str, Any]:
    """Load an artifact already captured as JSON (shadow logs, live captures, `ab` runs)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    # Accept either a bare artifact or a StepOutput-ish envelope.
    if isinstance(data, dict):
        for key in ("result", "payload"):
            inner = data.get(key)
            if isinstance(inner, dict) and ("content_text" in inner or "result" in inner):
                data = inner.get("result") if isinstance(inner.get("result"), dict) else inner
    return data if isinstance(data, dict) else {}


def load_dir(d: Path) -> dict[str, dict[str, Any]]:
    """Load every artifact in a directory, keyed by a normalised case id."""
    out: dict[str, dict[str, Any]] = {}
    for p in sorted(d.iterdir()):
        if p.suffix.lower() == ".md":
            out[_case_id(p)] = chapter_artifact(p)
        elif p.suffix.lower() == ".json":
            out[_case_id(p)] = json_artifact(p)
    return out


def _case_id(p: Path) -> str:
    """`05-chapter-01.md` and `chapter-01.md` both normalise to `chapter-01` so the two eras pair up."""
    stem = p.stem.lower()
    stem = re.sub(r"^\d+[-_]", "", stem)
    m = re.search(r"chapter[-_]?(\d+)", stem)
    return f"chapter-{int(m.group(1)):02d}" if m else stem


def build_cases(
    engine: dict[str, dict[str, Any]],
    baseline: dict[str, dict[str, Any]],
    *,
    tool: str,
    pair_by_id: bool,
    same_input: bool,
) -> tuple[list[ParityCase], str]:
    """Pair engine and baseline artifacts.

    Pairs by case id when ids overlap, else positionally. ``same_input`` is ASSERTED BY THE CALLER,
    never inferred: two files can share a normalised id (``chapter-01``) while describing completely
    different stories, which is not same-input parity. Unless the caller asserts it, the report
    carries a caveat so the number cannot be over-read.
    """
    shared = sorted(set(engine) & set(baseline))
    if pair_by_id and shared:
        cases = [ParityCase(cid, tool, engine[cid], baseline[cid]) for cid in shared]
        return cases, "" if same_input else _STRUCTURAL_CAVEAT

    e_keys, b_keys = sorted(engine), sorted(baseline)
    n = min(len(e_keys), len(b_keys))
    caveat = _STRUCTURAL_CAVEAT + " (Paired positionally — the two sides share no case ids.)"
    cases = [
        ParityCase(
            case_id=f"{e_keys[i]} vs {b_keys[i]}",
            tool=tool,
            engine=engine[e_keys[i]],
            baseline=baseline[b_keys[i]],
            note="positional pairing",
        )
        for i in range(n)
    ]
    return cases, caveat


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="L5 parity harness")
    sub = ap.add_subparsers(dest="mode", required=True)

    rec = sub.add_parser("recorded", help="engine artifacts vs stored baseline artifacts")
    rec.add_argument("--engine-dir", required=True, type=Path)
    rec.add_argument("--baseline-dir", required=True, type=Path)

    ab = sub.add_parser("ab", help="engine before a change vs engine after it")
    ab.add_argument("--before", required=True, type=Path)
    ab.add_argument("--after", required=True, type=Path)

    live = sub.add_parser("live", help="call the deployed engine + the n8n baseline per case")
    live.add_argument("--corpus", required=True, type=Path, help="JSON list of {case_id, payload}")
    live.add_argument("--gateway-url", required=True)
    live.add_argument("--n8n-webhook", required=True)

    for p in (rec, ab, live):
        p.add_argument("--tool", default="chapter")
        p.add_argument(
            "--same-input",
            action="store_true",
            help="assert both sides came from the SAME inputs; drops the structural caveat",
        )
        p.add_argument("--threshold", type=float, default=0.95)
        p.add_argument("--craft-tol", type=float, default=0.15)
        p.add_argument("--out", type=Path, default=Path("parity_out"))

    args = ap.parse_args(argv)

    if args.mode == "recorded":
        engine, baseline = load_dir(args.engine_dir), load_dir(args.baseline_dir)
        cases, caveat = build_cases(
            engine, baseline, tool=args.tool, pair_by_id=True, same_input=args.same_input
        )
        title = f"L5 parity — engine vs recorded n8n baseline ({args.tool})"
    elif args.mode == "ab":
        # A/B is same-input by construction, so always pair by id.
        before, after = load_dir(args.before), load_dir(args.after)
        cases, caveat = build_cases(after, before, tool=args.tool, pair_by_id=True, same_input=True)
        title = f"A/B parity — after vs before ({args.tool})"
    else:
        print(
            "live mode needs a running DEV engine + the n8n baseline webhook, and spends real "
            "provider budget. It is the A4 shape (same input, both systems) and is intended to be "
            "driven by the shadow window, not ad hoc. Not executed here.",
            file=sys.stderr,
        )
        return 2

    if not cases:
        print("no comparable artifacts found", file=sys.stderr)
        return 1

    report = run_corpus(cases, threshold=args.threshold, craft_tol=args.craft_tol)
    if caveat:
        report["caveat"] = caveat

    md = render_report(report, title=title)
    if caveat:
        md += f"\n> **Caveat.** {caveat}\n"

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "parity.json").write_text(json.dumps(report, indent=2))
    (args.out / "parity.md").write_text(md)
    print(md)
    print(f"[parity] wrote {args.out}/parity.json + parity.md", file=sys.stderr)
    return 0 if report["passes"] else 1


if __name__ == "__main__":
    sys.exit(main())
