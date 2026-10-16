"""L5 parity / shadow-diff scoring (F1-7 shadow + F1-7.5 acceptance A4).

When the DEV hub runs in *shadow* mode it executes BOTH the n8n tool and the engine call and needs a
single number for "did the engine agree with the n8n baseline?". This module computes that score
structurally — it does NOT require the two artifacts to be byte-identical (two LLM generations never
are), only that they agree on the shape and the measurable craft dimensions a reviewer would check.

``parity_score`` returns a 0..1 agreement plus a per-check breakdown, so the shadow log can show
*where* a tool diverges. The acceptance gate's A4 requires the mean over the shadow window ≥ 0.95.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

# Per-tool structural keys whose PRESENCE + rough shape should agree between engine and n8n.
# (Values differ run-to-run; we score structure + magnitude, not exact content.)
TOOL_KEYS: dict[str, list[str]] = {
    "chapter": ["content_text", "word_count", "sub_chapter_count"],
    "brainstorm": ["outline"],
    "research": ["report_markdown", "questions"],
    "media": ["image_url"],
}


def _num_close(a: Any, b: Any, *, tol: float = 0.35) -> bool:
    """Two numbers agree if within ``tol`` relative (default 35% — generations vary in length)."""
    try:
        a, b = float(a), float(b)
    except (TypeError, ValueError):
        return False
    if a == 0 and b == 0:
        return True
    hi = max(abs(a), abs(b))
    return hi == 0 or abs(a - b) / hi <= tol


def _present(v: Any) -> bool:
    if v is None:
        return False
    if isinstance(v, (str, list, dict)):
        return len(v) > 0
    return True


def parity_score(
    engine: dict[str, Any],
    baseline: dict[str, Any],
    *,
    tool: str = "chapter",
    craft_dims: list[str] | None = None,
    craft_tol: float = 0.15,
) -> dict[str, Any]:
    """Score how well an engine artifact agrees with the n8n baseline for ``tool``.

    Checks, each worth an equal share of the score:
      * each structural key in ``TOOL_KEYS[tool]`` is present in both (and, if numeric, within tol);
      * each craft-QA dimension (if both supply ``craft_qa``/``scores``) is within ``craft_tol``.

    Returns ``{"score": float, "agree": int, "total": int, "checks": [...], "tool": tool}``.
    """
    checks: list[dict[str, Any]] = []

    for key in TOOL_KEYS.get(tool, list(engine.keys())):
        ev, bv = engine.get(key), baseline.get(key)
        if isinstance(ev, (int, float)) or isinstance(bv, (int, float)):
            ok = _num_close(ev, bv)
            checks.append({"check": f"{key}~", "ok": ok, "engine": ev, "baseline": bv})
        else:
            ok = _present(ev) and _present(bv)
            checks.append({"check": f"{key}?", "ok": ok})

    e_craft = engine.get("craft_qa") or engine.get("scores") or {}
    b_craft = baseline.get("craft_qa") or baseline.get("scores") or {}
    if isinstance(e_craft, dict) and isinstance(b_craft, dict) and e_craft and b_craft:
        dims = craft_dims or sorted(set(e_craft) & set(b_craft))
        for d in dims:
            if d in e_craft and d in b_craft:
                ok = _num_close(e_craft[d], b_craft[d], tol=craft_tol)
                checks.append({"check": f"craft:{d}", "ok": ok, "engine": e_craft[d], "baseline": b_craft[d]})

    total = len(checks) or 1
    agree = sum(1 for c in checks if c["ok"])
    return {"score": round(agree / total, 4), "agree": agree, "total": total, "checks": checks, "tool": tool}


def shadow_summary(scores: list[dict[str, Any]], *, threshold: float = 0.95) -> dict[str, Any]:
    """Aggregate a shadow window's per-run parity scores into the A4 verdict."""
    vals = [s["score"] for s in scores if "score" in s]
    mean = round(sum(vals) / len(vals), 4) if vals else 0.0
    return {
        "runs": len(vals),
        "mean_parity": mean,
        "min_parity": round(min(vals), 4) if vals else 0.0,
        "threshold": threshold,
        "passes_A4": bool(vals) and mean >= threshold,
    }


# --- H3: the corpus harness ---------------------------------------------------------------------
#
# parity_score + shadow_summary above score ONE pair. What was missing (H3) was anything that
# produces pairs over a corpus and renders the A4 verdict — so the >=0.95 gate that every cutover is
# supposed to depend on had never been measured. These functions are the harness; the artifact
# loading and the engine/baseline invocation live in scripts/parity_run.py, which is corpus-specific.


@dataclass(frozen=True)
class ParityCase:
    """One engine artifact paired with the baseline it is being compared against."""

    case_id: str
    tool: str
    engine: dict[str, Any]
    baseline: dict[str, Any]
    note: str = ""


def run_corpus(
    cases: Sequence[ParityCase],
    *,
    threshold: float = 0.95,
    craft_tol: float = 0.15,
) -> dict[str, Any]:
    """Score every case and aggregate per tool and overall.

    Returns the full report: per-case scores, per-tool means, and the overall A4 verdict. Per-tool
    means matter because the gate is applied per tool at cutover — an overall mean can hide one tool
    sitting well below the line.
    """
    per_case: list[dict[str, Any]] = []
    for case in cases:
        scored = parity_score(case.engine, case.baseline, tool=case.tool, craft_tol=craft_tol)
        scored["case_id"] = case.case_id
        if case.note:
            scored["note"] = case.note
        per_case.append(scored)

    by_tool: dict[str, Any] = {}
    for tool in sorted({c.tool for c in cases}):
        subset = [s for s in per_case if s["tool"] == tool]
        by_tool[tool] = shadow_summary(subset, threshold=threshold)

    overall = shadow_summary(per_case, threshold=threshold)
    failing = sorted(t for t, v in by_tool.items() if not v["passes_A4"])
    return {
        "threshold": threshold,
        "overall": overall,
        "by_tool": by_tool,
        "failing_tools": failing,
        "passes": overall["passes_A4"] and not failing,
        "cases": per_case,
    }


def render_report(report: dict[str, Any], *, title: str = "L5 parity report") -> str:
    """Render a run as markdown. Kept here so the CLI and any CI job emit the same shape."""
    verdict = "PASS" if report["passes"] else "FAIL"
    lines = [
        f"# {title}",
        "",
        f"**Verdict: {verdict}** (threshold {report['threshold']}) — "
        f"{report['overall']['runs']} cases, mean {report['overall']['mean_parity']}, "
        f"min {report['overall']['min_parity']}",
        "",
        "| tool | cases | mean | min | passes |",
        "|---|---:|---:|---:|---|",
    ]
    for tool, agg in report["by_tool"].items():
        mark = "yes" if agg["passes_A4"] else "**NO**"
        lines.append(f"| {tool} | {agg['runs']} | {agg['mean_parity']} | {agg['min_parity']} | {mark} |")
    if report["failing_tools"]:
        lines += ["", f"Tools below the gate: **{', '.join(report['failing_tools'])}**"]

    worst = sorted(report["cases"], key=lambda c: c["score"])[:10]
    if worst:
        lines += [
            "",
            "## Lowest-scoring cases",
            "",
            "| case | tool | score | failed checks |",
            "|---|---|---:|---|",
        ]
        for c in worst:
            failed = ", ".join(k["check"] for k in c["checks"] if not k["ok"]) or "—"
            lines.append(f"| {c['case_id']} | {c['tool']} | {c['score']} | {failed} |")
    return "\n".join(lines) + "\n"
