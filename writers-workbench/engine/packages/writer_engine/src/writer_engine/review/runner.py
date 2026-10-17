"""Running review lenses over a draft, and shaping what comes back (E7).

One lens is one LLM pass. The output has to land in the shape the Q/A panel already renders —
``{name, status, details}`` — because the point of the design was no UI change and because
*Rewrite to fix Q/A* already consumes that shape.

Two choices worth stating:

* **Severity maps to status, and ``PASS`` means "this lens found nothing".** The panel has two
  states. A lens that found three things to fix produces three ``NEEDS_REVIEW`` rows; a lens that
  found nothing produces one ``PASS`` row, so the user can see the lens ran. Silence and absence
  look the same otherwise.
* **A lens that fails is reported, not swallowed.** ``chapter.qa``'s craft scoring returns a note
  when its JSON will not parse, and the same applies here: a lens whose call failed gets an
  ``ERROR`` row naming the lens. A review that quietly ran 3 of 4 lenses is worse than one that
  says so, because the user reads the absence of findings as approval.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from writer_engine.config import get_settings
from writer_engine.llm import complete_structured, get_router
from writer_engine.review import lenses as lens_mod
from writer_engine.telemetry.logging import get_logger

logger = get_logger("review")

MAX_DRAFT_CHARS = 60_000
"""About 10k words — comfortably a long chapter. A lens judging the first 10k words of a 30k-word
chapter would miss the end, so the caller should review sub-chapters separately above this."""

SEVERITIES = ("high", "medium", "low")

STATUS_PASS = "PASS"
STATUS_REVIEW = "NEEDS_REVIEW"
STATUS_ERROR = "ERROR"

_OUTPUT_CONTRACT = (
    "\n\n---\n\nReturn ONLY this JSON object:\n"
    '{"findings": [{"severity": "high|medium|low", "title": "<=70 chars naming the problem", '
    '"detail": "what is wrong and the specific fix, 1-3 sentences", '
    '"quote": "<=160 chars quoted verbatim from the draft, or empty"}], '
    '"summary": "one sentence on the draft as a whole"}\n'
    "Return an empty findings array when the draft genuinely passes this lens. Do not invent "
    "findings to fill the list, and do not include a finding you cannot point at in the text.\n"
)


class Finding(BaseModel):
    model_config = ConfigDict(extra="ignore")

    severity: str = "medium"
    title: str = ""
    detail: str = ""
    quote: str = ""

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: Any) -> Any:
        """Tolerate the shapes models actually return.

        A bare string ("Too many adverbs in paragraph 2") and the ``{problem, fix}`` pair both show
        up in practice; the same coercion exists on ``DriftReport`` for the same reason (A7).
        """
        if isinstance(data, str):
            return {"title": data[:70], "detail": data}
        if not isinstance(data, dict):
            return data
        out = dict(data)
        if not out.get("title"):
            out["title"] = str(out.get("problem") or out.get("issue") or out.get("name") or "")[:70]
        if not out.get("detail"):
            out["detail"] = str(out.get("fix") or out.get("problem") or out.get("suggestion") or "")
        sev = str(out.get("severity") or "").strip().lower()
        out["severity"] = sev if sev in SEVERITIES else "medium"
        return out

    @property
    def usable(self) -> bool:
        return bool((self.title or "").strip() or (self.detail or "").strip())


class LensReport(BaseModel):
    model_config = ConfigDict(extra="ignore")

    findings: list[Finding] = Field(default_factory=list)
    summary: str = ""

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, data: Any) -> Any:
        if isinstance(data, list):
            return {"findings": data}
        if not isinstance(data, dict):
            return data
        out = dict(data)
        for alias in ("issues", "problems", "results"):
            if not out.get("findings") and isinstance(out.get(alias), list):
                out["findings"] = out[alias]
        return out


def check_rows(lens: str, report: LensReport | None, *, error: str = "") -> list[dict[str, str]]:
    """One lens' report as Q/A panel rows."""
    name = lens_mod.label(lens)
    if error:
        return [{"name": name, "status": STATUS_ERROR, "details": f"This lens did not run: {error}"}]
    usable = [f for f in (report.findings if report else []) if f.usable]
    if not usable:
        summary = (report.summary if report else "").strip()
        return [{"name": name, "status": STATUS_PASS, "details": summary or "No findings."}]
    rows: list[dict[str, str]] = []
    for finding in usable:
        detail = finding.detail.strip() or finding.title.strip()
        if finding.quote.strip():
            detail = f"{detail}\n\n> {finding.quote.strip()}"
        rows.append(
            {
                "name": f"{name}: {finding.title.strip() or 'finding'}",
                "status": STATUS_REVIEW,
                "details": f"[{finding.severity}] {detail}",
            }
        )
    return rows


def _draft_block(draft: str, *, title: str = "", context: str = "") -> str:
    head = f"\n\nDRAFT TITLE: {title}" if title else ""
    ctx = f"\n\nCONTEXT THE AUTHOR GAVE:\n{context}" if context else ""
    return f"{head}{ctx}\n\n---\n\nDRAFT:\n\n{draft[:MAX_DRAFT_CHARS]}"


async def run_lens(
    lens: str,
    draft: str,
    *,
    title: str = "",
    context: str = "",
    model: str = "",
) -> tuple[LensReport | None, str]:
    """``(report, error)`` for one lens. Never raises."""
    settings = get_settings()
    try:
        prompt = lens_mod.lens_prompt(lens)
    except lens_mod.UnknownLens as exc:
        return None, f"unknown lens {exc}"

    try:
        report, _ = await complete_structured(
            get_router("review"),
            provider="anthropic",
            model=model or settings.model_cheap,
            system=(
                "You are a demanding editorial reviewer applying ONE specific lens to a draft. "
                "Critique only — do not rewrite the draft. Be concrete and point at the text."
            ),
            prompt=f"{prompt}{_draft_block(draft, title=title, context=context)}{_OUTPUT_CONTRACT}",
            schema=LensReport,
            max_tokens=4096,
            temperature=0.2,
        )
    except Exception as exc:
        detail = f"{type(exc).__name__}: {exc}"[:200]
        logger.warning("review.lens_failed", lens=lens, error=detail)
        return None, detail
    logger.info("review.lens_done", lens=lens, findings=len(report.findings))
    return report, ""


_SYNTHESIS = {
    "panel": (
        "You convened a review panel on one draft. Each reviewer below applied a different lens. "
        "Synthesize: where do they AGREE (that is the real problem), where do they CONFLICT (name "
        "the tension and say which side you take and why), and what are the prioritized fixes in "
        "order. Do not simply repeat every finding."
    ),
    "debate": (
        "You are adjudicating a disagreement between reviewers of one draft. Each applied a "
        "different lens and they do not all want the same thing. Argue the tensions through to a "
        "resolution: for each conflict, state both positions, then rule — or declare an "
        "acknowledged stalemate and say what the author has to decide. Be decisive."
    ),
}


async def synthesize(
    orchestrator: str,
    reports: dict[str, LensReport],
    *,
    title: str = "",
    model: str = "",
) -> tuple[LensReport | None, str]:
    """Run ``panel`` or ``debate`` over the member lenses' findings.

    Takes the findings rather than the draft: the whole point of these two is to reconcile the
    reviewers, and re-reading the prose would just produce a fourteenth opinion.
    """
    instruction = _SYNTHESIS.get(orchestrator)
    if instruction is None:
        return None, f"{orchestrator} is not an orchestrator"
    if not reports:
        return None, "no member lens produced a report to synthesize"

    settings = get_settings()
    transcript = "\n\n".join(
        f"### {lens_mod.label(lens)}\n"
        + (f"Summary: {report.summary}\n" if report.summary else "")
        + (
            "\n".join(f"- [{f.severity}] {f.title}: {f.detail}" for f in report.findings if f.usable)
            or "- (no findings)"
        )
        for lens, report in reports.items()
    )
    try:
        report, _ = await complete_structured(
            get_router("review"),
            provider="anthropic",
            model=model or settings.model_default,
            system="You are the editor who has to decide. Critique only — do not rewrite the draft.",
            prompt=(
                f"{instruction}\n\nDRAFT TITLE: {title or '(untitled)'}\n\n"
                f"REVIEWER OUTPUTS:\n\n{transcript}{_OUTPUT_CONTRACT}"
            ),
            schema=LensReport,
            max_tokens=4096,
            temperature=0.3,
        )
    except Exception as exc:
        detail = f"{type(exc).__name__}: {exc}"[:200]
        logger.warning("review.synthesis_failed", orchestrator=orchestrator, error=detail)
        return None, detail
    return report, ""


async def review_draft(
    draft: str,
    *,
    requested: list[str] | None = None,
    title: str = "",
    context: str = "",
    model: str = "",
) -> dict[str, Any]:
    """Run the requested lenses over one draft and return the review report.

    Shape::

        {generated_at, lenses, checks: [{name, status, details}], summaries: {lens: str},
         errors: {lens: str}, finding_count}

    ``checks`` is the Q/A panel's shape, so the panel renders this with no UI change.
    """
    text = (draft or "").strip()
    singles, orchestrators = lens_mod.expand(requested)
    if not text:
        return {
            "generated_at": datetime.now(UTC).isoformat(),
            "lenses": list(singles) + list(orchestrators),
            "checks": [{"name": "Review", "status": STATUS_ERROR, "details": "No draft text to review."}],
            "summaries": {},
            "errors": {"_draft": "empty"},
            "finding_count": 0,
        }

    checks: list[dict[str, str]] = []
    summaries: dict[str, str] = {}
    errors: dict[str, str] = {}
    reports: dict[str, LensReport] = {}

    # Serial, not gathered: every lens is an Anthropic call on the same account, so fanning out just
    # moves the queueing into the token budget's wait (B8/B9) — and a 4-lens panel is 4 calls.
    for lens in singles:
        report, error = await run_lens(lens, text, title=title, context=context, model=model)
        if error:
            errors[lens] = error
        if report is not None:
            reports[lens] = report
            if report.summary:
                summaries[lens] = report.summary
        checks.extend(check_rows(lens, report, error=error))

    for orchestrator in orchestrators:
        report, error = await synthesize(orchestrator, reports, title=title, model=model)
        if error:
            errors[orchestrator] = error
        if report is not None and report.summary:
            summaries[orchestrator] = report.summary
        checks.extend(check_rows(orchestrator, report, error=error))

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "lenses": list(singles) + list(orchestrators),
        "checks": checks,
        "summaries": summaries,
        "errors": errors,
        "finding_count": sum(1 for c in checks if c["status"] == STATUS_REVIEW),
    }


__all__ = [
    "MAX_DRAFT_CHARS",
    "SEVERITIES",
    "STATUS_ERROR",
    "STATUS_PASS",
    "STATUS_REVIEW",
    "Finding",
    "LensReport",
    "check_rows",
    "review_draft",
    "run_lens",
    "synthesize",
]
