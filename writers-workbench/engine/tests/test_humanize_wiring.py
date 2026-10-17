"""E6 wiring: non-fiction is humanized, fiction is not.

The decision this encodes (2026-10-17, after measuring a real scene and a real blog post):

* **blog_post / newsletter / social** are humanized automatically, before persisting, at
  mode=Low + outputFormat=markdown. On a real 1479-word post that setting scored 93, kept all 7
  markdown headings and lost no dates, where High lost the two dates the article was about and
  text format lost two headings.
* **chapter / short_story are NOT**, because both modes destroyed the researched period vocabulary
  a scene is grounded in: maize became corn, packed earth became flat stone.

The most important test here is the one asserting a short story is untouched. That is a decision
about the product, and a later refactor that "helpfully" routes all compose ops through one path
would undo it silently.
"""

from __future__ import annotations

from typing import Any

import pytest

from writer_engine import humanize as hz
from writer_engine.config import get_settings


@pytest.fixture(autouse=True)
def _fresh() -> Any:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def on(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Humanizer configured and reachable; returns the list of texts sent to the API."""
    sent: list[str] = []

    async def _fake(chunk: str, **kw: Any) -> dict[str, Any]:
        sent.append(chunk)
        return {"result": chunk + " [humanized]", "wordsSpent": len(chunk.split())}

    monkeypatch.setenv("STEALTHGPT_API_KEY", "test-token")
    monkeypatch.setattr(hz, "_stealthify", _fake)
    get_settings.cache_clear()
    return sent


def _post(words: int = 120) -> str:
    return " ".join(["Ugarit"] + ["word"] * words)


# --- the gate ----------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_draft_is_humanized_when_configured(on: list[str]) -> None:
    text, report = await hz.humanize_draft(_post(), content_type="blog_post")
    assert "[humanized]" in text
    assert report is not None
    assert report["content_type"] == "blog_post"
    assert report["humanized_chunks"] == 1
    assert len(on) == 1


@pytest.mark.asyncio
async def test_no_key_means_the_draft_is_returned_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STEALTHGPT_API_KEY", "")
    get_settings.cache_clear()
    original = _post()
    text, report = await hz.humanize_draft(original, content_type="blog_post")
    assert text == original
    assert report is None  # None distinguishes "did not run" from "ran and rejected everything"


@pytest.mark.asyncio
async def test_the_feature_flag_turns_it_off(on: list[str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUMANIZE_NON_FICTION", "false")
    get_settings.cache_clear()
    original = _post()
    text, report = await hz.humanize_draft(original, content_type="blog_post")
    assert text == original
    assert report is None
    assert on == []


@pytest.mark.asyncio
async def test_a_request_can_opt_out(on: list[str]) -> None:
    """`humanize: false` on one request, without touching the environment."""
    original = _post()
    text, report = await hz.humanize_draft(original, content_type="blog_post", payload={"humanize": False})
    assert text == original
    assert report is None
    assert on == []


@pytest.mark.asyncio
async def test_empty_text_is_not_sent(on: list[str]) -> None:
    text, report = await hz.humanize_draft("   ", content_type="newsletter")
    assert text == "   "
    assert report is None
    assert on == []


# --- the settings the measurements chose -------------------------------------------------------


def test_the_defaults_are_the_measured_ones() -> None:
    """Low + standard + markdown. Changing these should be a decision, not a drift."""
    s = get_settings()
    assert s.stealthgpt_mode == "Low"
    assert s.stealthgpt_model == "standard"
    assert s.stealthgpt_output_format == "markdown"


@pytest.mark.asyncio
async def test_markdown_is_the_format_actually_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    """text format lost 2 of 7 headings on a real post; markdown kept all 7."""
    seen: dict[str, Any] = {}

    async def _capture(chunk: str, **kw: Any) -> dict[str, Any]:
        seen.update(kw)
        return {"result": "ok", "wordsSpent": 1}

    monkeypatch.setenv("STEALTHGPT_API_KEY", "test-token")
    monkeypatch.setattr(hz, "_stealthify", _capture)
    get_settings.cache_clear()
    await hz.humanize_draft(_post(), content_type="blog_post")
    assert seen["output_format"] == "markdown"
    assert seen["mode"] == "Low"
    assert seen["model"] == "standard"


# --- the protect list a non-fiction draft has to supply itself ---------------------------------


def test_dates_are_extracted() -> None:
    """High dropped 1185 BCE and 1300 BCE — the two dates the article was about."""
    terms = hz.extract_protected_terms(
        "Somewhere around 1185 BCE a scribe wrote to the king. By 1150 BCE the city was gone."
    )
    assert "1185 BCE" in terms
    assert "1150 BCE" in terms


def test_proper_nouns_are_extracted() -> None:
    terms = hz.extract_protected_terms(
        "The port city of Ugarit sent letters to Alashiya and to Hattusa before the collapse."
    )
    assert {"Ugarit", "Alashiya", "Hattusa"} <= set(terms)


def test_ordinary_capitalised_words_are_not_protected() -> None:
    """A word wrongly protected rejects every rewrite, which costs the spend AND the humanizing."""
    terms = hz.extract_protected_terms(
        "However the city fell. Meanwhile the king waited. Eventually the letters stopped."
    )
    assert not ({"However", "Meanwhile", "Eventually"} & set(terms))


def test_a_word_that_also_appears_lowercase_is_not_a_name() -> None:
    """ "Climate" opening a sentence is not a proper noun when the text also says "climate"."""
    terms = hz.extract_protected_terms("Climate change hit the region. The climate shifted again.")
    assert "Climate" not in terms


def test_headings_are_skipped() -> None:
    """Every setting rewords headings, so protecting their words would reject every rewrite."""
    terms = hz.extract_protected_terms("## Reading Absence As Evidence\n\nThe city of Ugarit fell.")
    assert "Ugarit" in terms
    assert "Absence" not in terms and "Evidence" not in terms


def test_the_list_is_capped() -> None:
    text = " ".join(f"Propernoun{i}" for i in range(300))
    assert len(hz.extract_protected_terms(text)) <= hz.MAX_PROTECTED_TERMS


def test_extra_terms_come_first() -> None:
    terms = hz.extract_protected_terms("The city of Ugarit fell.", extra=["Sea Peoples"])
    assert terms[0] == "Sea Peoples"


# --- fiction stays out of it -------------------------------------------------------------------


def test_the_fiction_compose_ops_do_not_call_the_humanizer() -> None:
    """Asserted against the SOURCE, because the exclusion is the absence of a call.

    A refactor that routes every compose op through one shared persist path would humanize chapters
    and short stories without anyone noticing — which is the thing that was decided against.
    """
    from pathlib import Path

    import chapter_step.main as chapter_main

    src = Path(chapter_main.__file__).read_text()

    # The two non-fiction ops call it.
    assert 'humanize_draft(body, content_type="blog_post"' in src
    assert 'humanize_draft(body, content_type="newsletter"' in src

    # Nothing calls it for a chapter or a short story.
    for forbidden in ('content_type="chapter"', 'content_type="short_story"'):
        for line in src.splitlines():
            if "humanize_draft" in line:
                assert forbidden not in line, line

    # And the short-story op carries the reason, so the next reader does not "fix" it. Scoped to
    # the whole function, not an arbitrary prefix of it — the comment sits at the persist call.
    start = src.index("async def _op_short_story")
    end = src.index("\nOPS = {", start)
    assert "NOT humanized" in src[start:end]


def test_the_chapter_write_path_never_humanizes() -> None:
    """The chapter write is where the researched vocabulary lives; it must be untouched."""
    from pathlib import Path

    import chapter_step.main as chapter_main

    src = Path(chapter_main.__file__).read_text()
    write_block = src[src.index("async def _op_write") : src.index("async def _op_plan")]
    assert "humanize" not in write_block


# --- social posts: the platform cap ------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_social_rewrite_over_the_platform_limit_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A tweet pushed past 280 characters cannot be posted at all, so the original is kept."""
    import media_step.main as media_main

    async def _bloats(chunk: str, **kw: Any) -> dict[str, Any]:
        # Keeps the protected term, so the rewrite reaches the LENGTH check rather than being
        # rejected earlier by terms_lost — which is what the first version of this test hit.
        return {"result": "Ugarit " + "x" * 400, "wordsSpent": 50}

    monkeypatch.setenv("STEALTHGPT_API_KEY", "test-token")
    monkeypatch.setattr(hz, "_stealthify", _bloats)
    get_settings.cache_clear()

    original = " ".join(["Ugarit"] + ["word"] * 40)
    posts, report = await media_main._humanize_posts({"twitter": original}, {})
    assert posts["twitter"] == original
    assert report is not None
    assert report["platforms"]["twitter"]["rejected_for_length"]["limit"] == 280


@pytest.mark.asyncio
async def test_a_social_rewrite_within_the_limit_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    import media_step.main as media_main

    async def _ok(chunk: str, **kw: Any) -> dict[str, Any]:
        return {"result": "A shorter humanized post about Ugarit.", "wordsSpent": 40}

    monkeypatch.setenv("STEALTHGPT_API_KEY", "test-token")
    monkeypatch.setattr(hz, "_stealthify", _ok)
    get_settings.cache_clear()

    original = " ".join(["Ugarit"] + ["word"] * 40)
    posts, report = await media_main._humanize_posts({"twitter": original}, {})
    assert posts["twitter"] == "A shorter humanized post about Ugarit."
    assert "rejected_for_length" not in report["platforms"]["twitter"]


@pytest.mark.asyncio
async def test_social_posts_are_untouched_when_the_humanizer_is_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import media_step.main as media_main

    monkeypatch.setenv("STEALTHGPT_API_KEY", "")
    get_settings.cache_clear()
    posts = {"twitter": "a post", "linkedin": "another post"}
    out, report = await media_main._humanize_posts(dict(posts), {})
    assert out == posts
    assert report is None


# --- the extractor's false positives, found by a live run ---------------------------------------
#
# The first version protected any capitalised word that never appeared lower-cased. On a real blog
# generation that protected Textiles, Grain, Organic, Wood, Lead, Books, Discussion and Share — so
# 7 of 8 chunks were rejected and 2,796 words were billed to humanize one chunk. The missing
# condition: a real proper noun appears mid-sentence at least once.


def test_a_sentence_initial_common_noun_is_not_protected() -> None:
    """Follett prose is full of short declaratives whose first word looks like a name."""
    draft = (
        "Shipwrecks preserve a skewed picture of ancient trade. Wood rots. Textiles dissolve. "
        "Grain leaves nothing behind. Organic cargo is invisible to us now."
    )
    terms = hz.extract_protected_terms(draft)
    assert not ({"Wood", "Textiles", "Grain", "Organic"} & set(terms)), terms


def test_a_bold_label_is_not_protected() -> None:
    draft = "**Books**\n\nThe trade reached the port of Ugarit by sea.\n\n**Discussion prompt:** ask."
    terms = hz.extract_protected_terms(draft)
    assert "Ugarit" in terms
    assert not ({"Books", "Discussion"} & set(terms)), terms


def test_a_real_proper_noun_still_survives_the_stricter_rule() -> None:
    """The rule must not throw away the terms it exists to protect.

    These are the names the live run lost for real: Anatolian, Cypriot, Egypt, Hittite, Ugarit.
    """
    draft = (
        "Lead-isotope analysis traced the copper to Cyprus. The ingots reached Ugarit and Egypt, "
        "and the Hittite court recorded them. Tin came the other way from Anatolian sources, "
        "carried by Cypriot crews."
    )
    terms = set(hz.extract_protected_terms(draft))
    assert {"Cyprus", "Ugarit", "Egypt", "Hittite", "Anatolian", "Cypriot"} <= terms
    # "Lead" opens a sentence and is a metal, not a place.
    assert "Lead" not in terms


def test_the_known_limitation_a_name_only_ever_at_a_sentence_start() -> None:
    """Stated rather than hidden: such a name is NOT protected.

    The trade was made deliberately. Protecting every sentence-initial capital rejected 7 of 8
    chunks on a real draft and billed 2,796 words to humanize one of them; letting an occasional
    name through unprotected costs at most that one term. A caller who knows the term matters can
    always pass it via `extra` or `protect`.
    """
    draft = "Anatolian tin moved west. " + ("The route was long. " * 8)
    assert "Anatolian" not in hz.extract_protected_terms(draft)
    # And the escape hatch works.
    assert "Anatolian" in hz.extract_protected_terms(draft, extra=["Anatolian"])
