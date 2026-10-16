"""H3 — the L5 parity harness: corpus running, aggregation, and honest reporting.

parity_score/shadow_summary (one pair) already existed; nothing produced pairs over a corpus, so the
>=0.95 gate that every cutover depends on had never been measured. These cover the harness plus the
artifact extraction, because the extraction is where a parity number quietly becomes meaningless:
recorded artifacts are annotated CAPTURES, not raw step output, and the two eras annotate differently.
"""

from __future__ import annotations

import sys
from pathlib import Path

from writer_engine.parity import ParityCase, parity_score, render_report, run_corpus, shadow_summary

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from parity_run import build_cases, chapter_artifact, chapter_body


def _chapter(words: int, breaks: int = 0) -> dict:
    body = ("lorem " * words).strip()
    return {"content_text": body, "word_count": words, "sub_chapter_count": breaks + 1}


# --- corpus aggregation -----------------------------------------------------------------------


def test_run_corpus_aggregates_per_tool_and_overall() -> None:
    cases = [
        ParityCase("c1", "chapter", _chapter(1000), _chapter(1000)),
        ParityCase("c2", "chapter", _chapter(1000), _chapter(1050)),
        ParityCase(
            "r1",
            "research",
            {"report_markdown": "x", "questions": ["q"]},
            {"report_markdown": "y", "questions": ["q2"]},
        ),
    ]
    rep = run_corpus(cases)
    assert rep["overall"]["runs"] == 3
    assert set(rep["by_tool"]) == {"chapter", "research"}
    assert rep["by_tool"]["chapter"]["runs"] == 2
    assert rep["passes"] is True


def test_a_single_failing_tool_fails_the_run_even_with_a_good_overall_mean() -> None:
    """The gate is applied per tool at cutover, so an overall mean must not mask one bad tool."""
    good = [ParityCase(f"c{i}", "chapter", _chapter(1000), _chapter(1000)) for i in range(9)]
    bad = [ParityCase("m1", "media", {"image_url": "u"}, {"image_url": None})]
    rep = run_corpus(good + bad)
    assert rep["overall"]["mean_parity"] >= 0.9
    assert rep["by_tool"]["media"]["passes_A4"] is False
    assert rep["failing_tools"] == ["media"]
    assert rep["passes"] is False, "a failing tool must fail the whole run"


def test_threshold_is_honoured() -> None:
    cases = [ParityCase("c1", "chapter", _chapter(1000, 1), _chapter(1000, 9))]
    assert run_corpus(cases, threshold=0.95)["passes"] is False
    assert run_corpus(cases, threshold=0.6)["passes"] is True


def test_empty_corpus_does_not_claim_a_pass() -> None:
    rep = run_corpus([])
    assert rep["overall"]["runs"] == 0
    assert rep["passes"] is False


def test_report_names_the_failing_tool_and_checks() -> None:
    cases = [ParityCase("c1", "chapter", _chapter(1000, 1), _chapter(1000, 9))]
    md = render_report(run_corpus(cases))
    assert "FAIL" in md
    assert "sub_chapter_count" in md
    assert "c1" in md


# --- the honesty guards -----------------------------------------------------------------------


def test_same_input_must_be_asserted_not_inferred() -> None:
    """Two files can share a normalised id while describing totally different stories.

    Inferring same-input from a filename collision is how a structural number gets read as an A4
    parity number.
    """
    engine = {"chapter-01": _chapter(1000)}
    baseline = {"chapter-01": _chapter(1000)}

    _, caveat = build_cases(engine, baseline, tool="chapter", pair_by_id=True, same_input=False)
    assert "NOT same-input" in caveat

    _, caveat2 = build_cases(engine, baseline, tool="chapter", pair_by_id=True, same_input=True)
    assert caveat2 == ""


def test_positional_pairing_always_caveats() -> None:
    cases, caveat = build_cases(
        {"a": _chapter(100)}, {"z": _chapter(100)}, tool="chapter", pair_by_id=True, same_input=False
    )
    assert len(cases) == 1
    assert "positionally" in caveat


# --- artifact extraction ----------------------------------------------------------------------


def test_n8n_era_full_text_section_is_extracted() -> None:
    """n8n-era captures wrap the prose under '## Full text' after research/QA sections."""
    doc = (
        "# Chapter 1\n\n## Research woven in\n\nnotes notes\n\n"
        "## Final craft-QA\n\nscores\n\n## Full text\n\nreal prose here\n\n---\n\nmore prose\n"
    )
    body = chapter_body(doc)
    assert "real prose here" in body
    assert "Research woven in" not in body
    assert "scores" not in body


def test_engine_era_drift_preamble_is_stripped() -> None:
    """The engine capture's `---` separator would otherwise count as a scene break.

    Left in, EVERY engine chapter scores sub_chapter_count == 2 and the metric measures the capture
    format instead of the prose — which is exactly the trap this harness hit on its first run.
    """
    doc = '# Chapter 1: X\n\n> **drift report:** `{"aligned": true}`\n\n---\n\nThe prose begins.\n'
    body = chapter_body(doc)
    assert body.startswith("The prose begins")
    assert "drift report" not in body


def test_annotation_stripping_changes_the_measurement(tmp_path: Path) -> None:
    """Regression guard for the bug above: the preamble must not inflate the scene-break count."""
    p = tmp_path / "chapter-01.md"
    p.write_text("# Chapter 1\n\n> **drift report:** `{}`\n\n---\n\nOne scene, no breaks.\n")
    assert chapter_artifact(p)["sub_chapter_count"] == 1


def test_word_count_excludes_annotation(tmp_path: Path) -> None:
    p = tmp_path / "chapter-02.md"
    p.write_text('# T\n\n> **drift report:** `{"a":"' + ("pad " * 500) + '"}`\n\n---\n\nalpha beta gamma\n')
    assert chapter_artifact(p)["word_count"] == 3


def test_shadow_summary_matches_the_a4_shape() -> None:
    scores = [{"score": 0.96}, {"score": 0.98}, {"score": 0.94}]
    out = shadow_summary(scores, threshold=0.95)
    assert out["runs"] == 3
    assert out["min_parity"] == 0.94
    assert out["passes_A4"] is True  # mean 0.96


def test_parity_score_tolerates_generation_variance_but_not_structure() -> None:
    """Two LLM runs never match byte-for-byte; the gate must care about shape, not text."""
    assert parity_score(_chapter(1000), _chapter(1200), tool="chapter")["score"] == 1.0
    assert parity_score(_chapter(1000), _chapter(5000), tool="chapter")["score"] < 1.0
