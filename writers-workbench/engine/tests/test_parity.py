"""L5 parity / shadow-diff scoring (F1-7 shadow, A4 acceptance gate)."""

from __future__ import annotations

from writer_engine.parity import parity_score, shadow_summary


def test_identical_chapter_scores_1() -> None:
    art = {"content_text": "x " * 100, "word_count": 200, "sub_chapter_count": 5,
           "craft_qa": {"prose_transparent": 0.9, "story_turn_density": 0.85}}
    r = parity_score(art, dict(art), tool="chapter")
    assert r["score"] == 1.0
    assert r["agree"] == r["total"]


def test_word_count_within_tolerance_agrees() -> None:
    eng = {"content_text": "a", "word_count": 8200, "sub_chapter_count": 5}
    base = {"content_text": "b", "word_count": 6600, "sub_chapter_count": 5}  # n8n baseline shorter
    r = parity_score(eng, base, tool="chapter")
    # 8200 vs 6600 is within 35% relative -> the length check agrees
    assert any(c["check"] == "word_count~" and c["ok"] for c in r["checks"])


def test_missing_structural_key_lowers_score() -> None:
    eng = {"content_text": "", "word_count": 0, "sub_chapter_count": 5}  # empty text = not present
    base = {"content_text": "real chapter", "word_count": 7000, "sub_chapter_count": 5}
    r = parity_score(eng, base, tool="chapter")
    assert r["score"] < 1.0
    assert any(c["check"] == "content_text?" and not c["ok"] for c in r["checks"])


def test_craft_dim_divergence_flagged() -> None:
    eng = {"content_text": "x", "word_count": 7000, "sub_chapter_count": 5,
           "craft_qa": {"story_turn_density": 0.4}}
    base = {"content_text": "y", "word_count": 7000, "sub_chapter_count": 5,
            "craft_qa": {"story_turn_density": 0.9}}  # 0.4 vs 0.9 diverges beyond craft_tol
    r = parity_score(eng, base, tool="chapter")
    assert any(c["check"] == "craft:story_turn_density" and not c["ok"] for c in r["checks"])


def test_brainstorm_outline_presence() -> None:
    r = parity_score({"outline": {"chapters": [1, 2]}}, {"outline": {"chapters": [1]}}, tool="brainstorm")
    assert r["score"] == 1.0  # both present


def test_shadow_summary_passes_A4_at_threshold() -> None:
    scores = [{"score": 0.96}, {"score": 0.97}, {"score": 0.95}]
    s = shadow_summary(scores)
    assert s["passes_A4"] is True
    assert s["mean_parity"] >= 0.95
    assert s["runs"] == 3


def test_shadow_summary_fails_below_threshold() -> None:
    s = shadow_summary([{"score": 0.9}, {"score": 0.8}])
    assert s["passes_A4"] is False
