"""E6 — the StealthGPT humanize pass.

Decisions this encodes (2026-10-17): fiction is humanized by an explicit, revertible pass rather
than automatically; a failed chunk RETRIES and then falls back to the original text; and the pass
is off entirely unless a key is configured.

The structural tests matter more than the happy path. The humanizer rewrites prose, so it is the
natural place to lose two things the engine works hard to guarantee: A13's scene separators (already
destroyed once today by a regex) and the no-em-dash writing directive (which a rewriting pass
reintroduces freely).
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from writer_engine import humanize as hz
from writer_engine.config import get_settings
from writer_engine.humanize import judge_rewrite

SCENE = hz.SCENE_BREAK


@pytest.fixture(autouse=True)
def _fresh_settings() -> Any:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STEALTHGPT_API_KEY", "test-token")
    get_settings.cache_clear()


def _para(words: int, word: str = "word") -> str:
    return " ".join([word] * words)


class _Api:
    """Records the requests and returns a canned humanized result per call.

    Failures are keyed on the chunk's CONTENT, not on the call index. A failing chunk is retried
    (attempts=3), so the call index runs ahead of the chunk index and an index-keyed stub starts
    failing the wrong chunk — which is how the first version of these tests failed.
    """

    def __init__(self, *, fail_words: set[str] | None = None, empty_words: set[str] | None = None) -> None:
        self.calls: list[str] = []
        self.fail_words = fail_words or set()
        self.empty_words = empty_words or set()

    async def __call__(self, chunk: str, **kw: Any) -> dict[str, Any]:
        self.calls.append(chunk)
        if any(w in chunk for w in self.fail_words):
            request = httpx.Request("POST", hz.ENDPOINT)
            raise httpx.HTTPStatusError(
                "boom", request=request, response=httpx.Response(500, request=request)
            )
        if any(w in chunk for w in self.empty_words):
            return {"result": "", "wordsSpent": 0}
        return {
            "result": f"HUMANIZED({chunk[:24]})",
            "wordsSpent": len(chunk.split()),
            "remainingCredits": 1000 - len(self.calls),
            "howLikelyToBeDetected": "low",
        }


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> _Api:
    stub = _Api()
    monkeypatch.setattr(hz, "_stealthify", stub)
    return stub


# --- off by default ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_key_means_no_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    """It is billed per word and can flatten literary voice. Absence of a key means OFF."""
    monkeypatch.setenv("STEALTHGPT_API_KEY", "")
    get_settings.cache_clear()
    assert hz.enabled() is False
    out = await hz.humanize_text("Some prose.")
    assert out.text == "Some prose."
    assert out.skipped
    assert out.humanized_chunks == 0


@pytest.mark.asyncio
async def test_a_key_enables_it(key: None) -> None:
    assert hz.enabled() is True


@pytest.mark.asyncio
async def test_empty_input_is_a_no_op(key: None, api: _Api) -> None:
    out = await hz.humanize_text("   \n  ")
    assert out.skipped == "empty input"
    assert api.calls == []


# --- chunking ----------------------------------------------------------------------------------


def test_short_text_is_one_chunk() -> None:
    assert len(hz.chunk_text(_para(50))) == 1


def test_it_splits_on_scene_breaks_first() -> None:
    """A scene is never split across two requests, so the separators can be restored verbatim."""
    text = SCENE.join([_para(100, "a"), _para(100, "b"), _para(100, "c")])
    chunks = hz.chunk_text(text)
    assert len(chunks) == 3
    assert "---" not in "".join(chunks)  # the separator itself is never sent to the API


def test_an_oversized_scene_is_split_on_paragraphs() -> None:
    scene = "\n\n".join(_para(1000) for _ in range(5))  # 5000 words in one scene
    chunks = hz.chunk_text(scene, max_words=2800)
    assert len(chunks) > 1
    assert all(len(c.split()) <= 2800 for c in chunks)
    # Nothing is lost and nothing is duplicated.
    assert sum(len(c.split()) for c in chunks) == 5000


def test_a_single_oversized_paragraph_is_not_cut_mid_sentence() -> None:
    """Passing it through whole is visible (the API complains); a sliced sentence is not."""
    chunks = hz.chunk_text(_para(4000), max_words=2800)
    assert len(chunks) == 1
    assert len(chunks[0].split()) == 4000


def test_no_chunk_exceeds_the_api_cap_for_realistic_chapter_text() -> None:
    """A 7k-word chapter of 5 scenes: every request must fit under 3000 words."""
    text = SCENE.join("\n\n".join(_para(350) for _ in range(4)) for _ in range(5))
    assert len(text.split()) > 6000
    assert all(len(c.split()) <= hz.CHUNK_WORDS for c in hz.chunk_text(text))


# --- structure preservation --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_scene_breaks_survive_the_pass(key: None, api: _Api) -> None:
    """The point of chunking on breaks: N scenes in, N-1 separators out, whatever the model returns."""
    text = SCENE.join([_para(100, "alpha"), _para(100, "beta"), _para(100, "gamma")])
    out = await hz.humanize_text(text)
    assert out.text.count("---") == 2
    assert out.humanized_chunks == 3


@pytest.mark.asyncio
async def test_the_separator_is_never_sent_to_the_provider(key: None, api: _Api) -> None:
    """Sending it invites the model to reword or drop it."""
    text = SCENE.join([_para(100, "alpha"), _para(100, "beta")])
    await hz.humanize_text(text)
    assert all("---" not in c for c in api.calls)


@pytest.mark.asyncio
async def test_em_dashes_the_humanizer_introduces_are_stripped(
    key: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rewriting pass reintroduces banned dashes; not re-stripping would undo the line-edit."""

    async def _returns_dashes(chunk: str, **kw: Any) -> dict[str, Any]:
        return {"result": "She paused—then spoke--again.", "wordsSpent": 5}

    monkeypatch.setattr(hz, "_stealthify", _returns_dashes)
    out = await hz.humanize_text(_para(100))
    assert "—" not in out.text
    assert "--" not in out.text


def test_the_dash_stripper_does_not_eat_the_separator() -> None:
    """The exact bug found in chapter_step today, which this module must not reproduce."""
    text = f"Scene one.{SCENE}Scene two."
    out = hz.strip_banned_dashes(text)
    assert out.count("---") == 1
    assert ", -" not in out


# --- failure handling --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_failed_chunk_keeps_the_original_and_is_reported(
    key: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Retry, then fall back — and never present a partial pass as a finished one."""
    stub = _Api(fail_words={"keepme"})
    monkeypatch.setattr(hz, "_stealthify", stub)
    original = _para(100, "keepme")
    text = SCENE.join([_para(100, "alpha"), original, _para(100, "gamma")])

    out = await hz.humanize_text(text)
    assert out.failed_chunks == [1]
    assert out.humanized_chunks == 2
    assert out.partial is True
    assert out.ok is False
    assert "keepme" in out.text  # the original survived for that chunk
    assert out.text.count("---") == 2  # structure still intact


@pytest.mark.asyncio
async def test_a_200_with_no_text_counts_as_a_failure(key: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Treating an empty result as success would silently blank part of the chapter."""
    stub = _Api(empty_words={"original"})
    monkeypatch.setattr(hz, "_stealthify", stub)
    out = await hz.humanize_text(_para(100, "original"))
    assert out.failed_chunks == [0]
    assert "original" in out.text


@pytest.mark.asyncio
async def test_every_chunk_failing_leaves_the_text_untouched(
    key: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub = _Api(fail_words={"alpha", "beta"})
    monkeypatch.setattr(hz, "_stealthify", stub)
    text = SCENE.join([_para(100, "alpha"), _para(100, "beta")])
    out = await hz.humanize_text(text)
    assert out.humanized_chunks == 0
    assert out.partial is False  # nothing was humanized, so it is not a mixed-voice chapter
    assert "alpha" in out.text and "beta" in out.text


@pytest.mark.asyncio
async def test_a_tiny_fragment_is_passed_through_not_billed(key: None, api: _Api) -> None:
    """Below MIN_WORDS there is nothing worth paying to rewrite, and a rewrite would not match."""
    text = SCENE.join([_para(100, "alpha"), "Yes.", _para(100, "gamma")])
    out = await hz.humanize_text(text)
    assert len({" ".join(c.split()[:1]) for c in api.calls}) == 2  # distinct chunks, not retries
    assert len(api.calls) == 2
    assert "Yes." in out.text
    assert out.failed_chunks == []  # a pass-through is not a failure


# --- accounting --------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_it_reports_what_it_spent(key: None, api: _Api) -> None:
    """Billed per word, so the caller needs the cost and the remaining balance."""
    out = await hz.humanize_text(SCENE.join([_para(100), _para(100)]))
    assert out.words_spent == 200
    assert out.remaining_credits is not None
    assert out.detectability == "low"
    report = out.as_report()
    assert report["humanized_chunks"] == 2
    assert report["partial"] is False


@pytest.mark.asyncio
async def test_the_request_body_matches_the_documented_api(
    key: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """model and mode are required fields; rephrase must be true or nothing is rewritten."""
    seen: dict[str, Any] = {}

    async def _capture(chunk: str, **kw: Any) -> dict[str, Any]:
        seen.update(kw)
        seen["chunk"] = chunk
        return {"result": "ok", "wordsSpent": 1}

    monkeypatch.setattr(hz, "_stealthify", _capture)
    await hz.humanize_text(_para(100), model="super", mode="Medium")
    assert seen["model"] == "super"
    assert seen["mode"] == "Medium"
    assert seen["key"] == "test-token"


@pytest.mark.asyncio
async def test_settings_supply_the_defaults(key: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STEALTHGPT_MODEL", "lite")
    monkeypatch.setenv("STEALTHGPT_MODE", "Low")
    get_settings.cache_clear()
    seen: dict[str, Any] = {}

    async def _capture(chunk: str, **kw: Any) -> dict[str, Any]:
        seen.update(kw)
        return {"result": "ok", "wordsSpent": 1}

    monkeypatch.setattr(hz, "_stealthify", _capture)
    await hz.humanize_text(_para(100))
    assert seen["model"] == "lite"
    assert seen["mode"] == "Low"


@pytest.mark.asyncio
async def test_each_chunk_sends_its_own_text(key: None, api: _Api) -> None:
    """A closure over the loop variable would send the LAST chunk every time."""
    text = SCENE.join([_para(100, "alpha"), _para(100, "beta"), _para(100, "gamma")])
    await hz.humanize_text(text)
    assert len(api.calls) == 3
    assert "alpha" in api.calls[0]
    assert "beta" in api.calls[1]
    assert "gamma" in api.calls[2]


# --- the spend ceiling -------------------------------------------------------------------------
#
# Measured against the live API on 2026-10-17: billing is ~2x the input words on `standard` and ~6x
# on `super`, and the account is pay-as-you-go with remainingCredits already at 0. So nothing
# upstream would stop a mistaken "humanize all" — 96 chapters x 7k words is ~1.3M billed words.


@pytest.mark.asyncio
async def test_the_pass_stops_at_the_word_ceiling(
    key: None, api: _Api, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HUMANIZE_MAX_WORDS_PER_RUN", "150")
    get_settings.cache_clear()
    # Four scenes of 100 words; the stub bills the chunk's own word count, so the ceiling bites
    # partway through.
    text = SCENE.join([_para(100, w) for w in ("alpha", "beta", "gamma", "delta")])

    out = await hz.humanize_text(text)
    assert out.stopped_at_budget is True
    assert out.words_spent <= 200  # stopped as soon as it was at or over the ceiling
    assert out.humanized_chunks < 4
    # Everything it did not humanize keeps its original text, and the structure is still intact.
    assert "delta" in out.text
    assert out.text.count("---") == 3


@pytest.mark.asyncio
async def test_a_generous_ceiling_does_not_interfere(
    key: None, api: _Api, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HUMANIZE_MAX_WORDS_PER_RUN", "100000")
    get_settings.cache_clear()
    out = await hz.humanize_text(SCENE.join([_para(100, "alpha"), _para(100, "beta")]))
    assert out.stopped_at_budget is False
    assert out.humanized_chunks == 2


@pytest.mark.asyncio
async def test_a_zero_ceiling_means_unlimited_not_disabled(
    key: None, api: _Api, monkeypatch: pytest.MonkeyPatch
) -> None:
    """0 is the escape hatch for an operator who knows what they are spending."""
    monkeypatch.setenv("HUMANIZE_MAX_WORDS_PER_RUN", "0")
    get_settings.cache_clear()
    out = await hz.humanize_text(SCENE.join([_para(100, "alpha"), _para(100, "beta")]))
    assert out.stopped_at_budget is False
    assert out.humanized_chunks == 2


@pytest.mark.asyncio
async def test_the_metered_charge_is_recorded(key: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """On a payg account with 0 remaining credits, meteredChargedCredits IS the cost."""

    async def _billed(chunk: str, **kw: Any) -> dict[str, Any]:
        return {"result": "rewritten", "wordsSpent": 60, "meteredChargedCredits": 60}

    monkeypatch.setattr(hz, "_stealthify", _billed)
    out = await hz.humanize_text(SCENE.join([_para(100, "a"), _para(100, "b")]))
    assert out.charged_credits == 120
    assert out.as_report()["charged_credits"] == 120


# --- acceptance checks on the OUTPUT -----------------------------------------------------------
#
# Both checks come from measuring the live API on a real 1431-word scene of The Burial Mound:
# mode=High replaced the character name "Tayak" with "He" on a short passage, and mode=Medium —
# which scored BEST of all five settings at 94 — rewrote 31 paragraphs into 7.


def test_a_rewrite_that_drops_a_protected_name_is_rejected() -> None:
    original = "Tayak counted three guards along the parapet. He turned back into the pines."
    rewritten = "He counted three men on the parapet. He went back into the pines."
    assert judge_rewrite(original, rewritten, protect=["Tayak"]).startswith("names_lost:Tayak")


def test_a_rewrite_that_keeps_the_name_passes() -> None:
    original = "Tayak counted three guards along the parapet."
    rewritten = "Tayak counted three guards on the wall."
    assert judge_rewrite(original, rewritten, protect=["Tayak"]) == ""


def test_only_names_actually_in_the_original_are_required() -> None:
    """A roster is project-wide; a scene that never mentions Kimi must not be rejected for it."""
    assert judge_rewrite("Tayak walked.", "Tayak strolled.", protect=["Tayak", "Kimi", "Nora"]) == ""


def test_a_structural_collapse_is_rejected() -> None:
    """mode=Medium scored 94 and turned 31 paragraphs into 7. Paragraphing is craft."""
    original = "\n\n".join(f"Paragraph {i} with some words in it." for i in range(10))
    collapsed = "All ten paragraphs mashed into one block of text with no breaks at all."
    assert judge_rewrite(original, collapsed).startswith("structure_collapsed:10->1")


def test_one_merged_paragraph_is_tolerated() -> None:
    """mode=Low kept 30 of 31. Rejecting that would reject the setting we actually want."""
    original = "\n\n".join(f"Paragraph {i} with some words." for i in range(31))
    merged = "\n\n".join(f"Paragraph {i} with some words." for i in range(30))
    assert judge_rewrite(original, merged) == ""


def test_short_text_is_not_judged_on_structure() -> None:
    """A one or two paragraph chunk has no structure to collapse."""
    assert judge_rewrite("One para.", "A single rewritten para.") == ""
    assert judge_rewrite("One.\n\nTwo.", "Just one now.") == ""


def test_names_present_matches_whole_words() -> None:
    assert hz.names_present("Sokan waited.", ["Sokan"]) == {"Sokan"}
    assert hz.names_present("Sokanish is a word.", ["Sokan"]) == set()


@pytest.mark.asyncio
async def test_a_rejected_chunk_keeps_the_original_and_records_why(
    key: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The call succeeded and is billed; the OUTPUT is what failed. Keep the original, say why."""

    async def _drops_the_name(chunk: str, **kw: Any) -> dict[str, Any]:
        return {
            "result": chunk.replace("Tayak", "He"),
            "wordsSpent": 100,
            "meteredChargedCredits": 100,
        }

    monkeypatch.setattr(hz, "_stealthify", _drops_the_name)
    original = "Tayak " + _para(100, "walked")
    out = await hz.humanize_text(original, protect=["Tayak"])

    assert out.humanized_chunks == 0
    assert out.failed_chunks == [0]
    assert out.rejected[0].startswith("names_lost:Tayak")
    assert "Tayak" in out.text  # the original survived
    # Still billed — a rejection is not a refund, and the report must not hide the spend.
    assert out.charged_credits == 100
    assert out.as_report()["rejected"] == {0: "names_lost:Tayak"}


@pytest.mark.asyncio
async def test_an_acceptable_rewrite_is_kept(key: None, monkeypatch: pytest.MonkeyPatch) -> None:
    async def _keeps_the_name(chunk: str, **kw: Any) -> dict[str, Any]:
        return {"result": chunk.replace("walked", "strode"), "wordsSpent": 100}

    monkeypatch.setattr(hz, "_stealthify", _keeps_the_name)
    out = await hz.humanize_text("Tayak " + _para(100, "walked"), protect=["Tayak"])
    assert out.humanized_chunks == 1
    assert out.rejected == {}
    assert "strode" in out.text
