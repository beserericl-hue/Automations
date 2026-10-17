"""E1 / J6 — the ingestion key convention, and the bug that killed 23 days of it.

The keys asserted here are real rows from DEV's ``content_ingestion_v2``. They are the contract: a
new row only joins its own history if the engine spells the key the way n8n did.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from writer_engine.ingestion.keys import (
    build_key,
    is_safe_key,
    parse_published_date,
    slugify_source,
    slugify_title,
)

NOW = datetime(2026, 10, 17, 18, 30, tzinfo=UTC)


class TestSlug:
    def test_matches_live_corpus_keys(self) -> None:
        """Three real DEV rows, re-derived from their title + source."""
        cases = [
            (
                "AI has no motivation",
                "i-programmer",
                "2026-09-24",
                "2026-09-24/ai-has-no-motivation.i-programmer",
            ),
            (
                "Australia launches urgent review after OpenAI program hacks government health portal",
                "bbc",
                "2026-09-24",
                "2026-09-24/australia-launches-urgent-review-after-openai-program-hacks-"
                "government-health-portal.bbc",
            ),
            (
                "OpenAI agent hacked into Australia's national healthcare system",
                "cnn",
                "2026-09-23",
                "2026-09-23/openai-agent-hacked-into-australias-national-healthcare-system.cnn",
            ),
        ]
        for title, source, published, expected in cases:
            assert build_key(title=title, source_name=source, published=published) == expected

    def test_drops_punctuation_and_collapses_dashes(self) -> None:
        assert (
            slugify_title("Meta's  Zuckerberg says: Muse — AI agent!!")
            == "metas-zuckerberg-says-muse-ai-agent"
        )

    def test_keeps_existing_dashes(self) -> None:
        # The n8n character class allows a literal dash through, so "GPT-5" stays "gpt-5".
        assert slugify_title("GPT-5 ships") == "gpt-5-ships"

    def test_caps_length(self) -> None:
        slug = slugify_title("word " * 200)
        assert len(slug) <= 120
        assert not slug.endswith("-")

    def test_unslugifiable_title_is_empty(self) -> None:
        assert slugify_title("日本語のみ") == ""
        assert slugify_title("🚀🚀🚀") == ""

    def test_source_tag_collapses_dots(self) -> None:
        assert slugify_source("finance.yahoo.com") == "finance-yahoo-com"


class TestPublishedDate:
    def test_iso_with_zulu(self) -> None:
        assert parse_published_date("2026-09-24T10:04:39.735907Z") == date(2026, 9, 24)

    def test_rfc822_pubdate(self) -> None:
        """Plain RSS XML carries this shape, and ``fromisoformat`` cannot read it."""
        assert parse_published_date("Fri, 17 Oct 2026 09:30:00 GMT", now=NOW) == date(2026, 10, 17)

    def test_reddit_epoch(self) -> None:
        assert parse_published_date(1_792_000_000) == date(2026, 10, 14)
        assert parse_published_date(1_792_000_000.5) == date(2026, 10, 14)

    def test_absurd_epoch_falls_back_to_today(self) -> None:
        # Not 1970: a key under a decade-old prefix is invisible to every date-prefix query.
        assert parse_published_date(0, now=NOW) == date(2026, 10, 17)

    def test_datetime_and_date_pass_through(self) -> None:
        assert parse_published_date(datetime(2026, 1, 2, tzinfo=UTC)) == date(2026, 1, 2)
        assert parse_published_date(date(2026, 1, 3)) == date(2026, 1, 3)


class TestJ6:
    """The regression. ``2T3TwGHhdGQlTpQ5`` died every 4h from 2026-09-24 because one feed entry
    had no ``isoDate``: ``$json.isoDate.substring(0, 10)`` emptied the key, ``/api/ingestion/search``
    answered 400 ``prefix: key is required``, and the whole execution — every other feed's items
    included — went down with it."""

    def test_missing_date_falls_back_to_today_instead_of_failing(self) -> None:
        key = build_key(title="OpenAI ships a thing", source_name="techcrunch", published=None, now=NOW)
        assert key == "2026-10-17/openai-ships-a-thing.techcrunch"

    def test_unparseable_date_falls_back_to_today(self) -> None:
        key = build_key(
            title="OpenAI ships a thing", source_name="techcrunch", published="yesterday", now=NOW
        )
        assert key == "2026-10-17/openai-ships-a-thing.techcrunch"

    def test_unkeyable_title_returns_none_rather_than_a_junk_key(self) -> None:
        # The n8n expression would have produced "2026-10-17/.bbc" — safe-looking and meaningless.
        assert build_key(title="🚀", source_name="bbc", now=NOW) is None
        assert build_key(title="", source_name="bbc", now=NOW) is None

    def test_missing_source_returns_none(self) -> None:
        assert build_key(title="A real headline", source_name="", now=NOW) is None


class TestSafety:
    def test_rejects_traversal_and_leading_slash(self) -> None:
        assert not is_safe_key("../etc/passwd")
        assert not is_safe_key("/2026-10-17/x.bbc")
        assert not is_safe_key("")

    def test_rejects_characters_the_upload_route_rejects(self) -> None:
        assert not is_safe_key("2026-10-17/a b.bbc")
        assert not is_safe_key("2026-10-17/a%20b.bbc")

    def test_accepts_a_real_key(self) -> None:
        assert is_safe_key("2026-09-24/ai-has-no-motivation.i-programmer")

    def test_overlong_key_is_rejected_by_build(self) -> None:
        # Slug cap + source cap keep the whole key well inside the 512-char column, but the guard
        # is what makes that a property rather than an accident.
        key = build_key(title="x" * 400, source_name="y" * 400, now=NOW)
        assert key is not None and len(key) < 512
