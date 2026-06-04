"""media-step cover-art / scrape-url: prompt building, slug, and no-key fixture fallbacks."""

from __future__ import annotations

import asyncio

from media_step.main import _cover_prompt, _op_cover_art, _op_scrape_url, _slug


def test_slug_sanitizes() -> None:
    assert _slug("The Burial Mound!") == "the-burial-mound"
    assert _slug("---") == "cover"


def test_cover_prompt_includes_title_genre_no_text() -> None:
    p = _cover_prompt({"title": "The Burial Mound", "genre_slug": "ancient-history",
                       "summary": "A Piscataway archaeologist excavates a mound."})
    assert "The Burial Mound" in p
    assert "ancient-history" in p
    assert "no text" in p  # covers must not render title text


def test_cover_art_fixture_without_keys() -> None:
    # no KIE/OpenAI keys configured in the test env -> stub placeholder, never raises
    out = asyncio.run(_op_cover_art({"title": "The Burial Mound", "user_id": "u1"}))
    assert out["provider"] in ("stub", "kieai", "dalle")
    assert "image_url" in out and out["prompt"]


def test_scrape_url_requires_url() -> None:
    out = asyncio.run(_op_scrape_url({}))
    assert out["url"] is None
    assert out["markdown"] == ""


def test_scrape_url_stub_without_key() -> None:
    out = asyncio.run(_op_scrape_url({"url": "https://example.com"}))
    # without FIRECRAWL_API_KEY the op returns a stub marker, never raises
    assert out["url"] == "https://example.com"
    assert "markdown" in out
