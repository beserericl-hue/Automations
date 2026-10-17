"""E1 — the publisher label.

Two n8n workflows disagreed about this. The one that wrote the 3,926 rows in DEV mapped an
aggregator item's own domain (``bbc``, ``yahoo-finance``, ``i-programmer``); the multi-user cron
slugged the feed row's name, which would have filed every Google News item under ``google-news-ai``
and lost the publisher the reader recognises.
"""

from __future__ import annotations

import pytest

from writer_engine.ingestion.sources import (
    AGGREGATOR_DOMAIN_THRESHOLD,
    domain_of,
    is_aggregator,
    source_name_for_domain,
    source_name_for_feed,
)


class TestDomain:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("https://www.bbc.com/news/x", "bbc.com"),
            ("http://finance.yahoo.com/news/y", "finance.yahoo.com"),
            ("techcrunch.com/2026/10/17/z", "techcrunch.com"),
            ("https://WWW.Forbes.COM/sites/a", "forbes.com"),
            ("", ""),
            ("not a url at all", "not a url at all"),
        ],
    )
    def test_hostname(self, url: str, expected: str) -> None:
        assert domain_of(url) == expected


class TestLabelFromDomain:
    def test_mapped_domains_match_the_live_corpus(self) -> None:
        assert source_name_for_domain("finance.yahoo.com") == "yahoo-finance"
        assert source_name_for_domain("techcrunch.com") == "techcrunch"
        assert source_name_for_domain("theverge.com") == "the-verge"
        assert source_name_for_domain("nytimes.com") == "the-new-york-times"

    def test_unmapped_domain_uses_the_n8n_fallback(self) -> None:
        """Drop the TLD, dots to dashes — which is how ``i-programmer`` got into the corpus."""
        assert source_name_for_domain("i-programmer.info") == "i-programmer"
        assert source_name_for_domain("transluce.org") == "transluce"
        assert source_name_for_domain("business.inquirer.net") == "business-inquirer"
        assert source_name_for_domain("some.deep.sub.example.com") == "some-deep-sub-example"

    def test_empty(self) -> None:
        assert source_name_for_domain("") == ""


class TestLabelFromFeedName:
    def test_subreddit_name_matches_the_n8n_spelling(self) -> None:
        """The self-post normalizers wrote ``reddit-artificial``, not ``r-artificial``."""
        assert source_name_for_feed("r/artificial") == "reddit-artificial"
        assert source_name_for_feed("r/PostApocalypticFiction") == "reddit-postapocalypticfiction"
        assert source_name_for_feed("r/OpenAI/") == "reddit-openai"

    def test_publisher_names(self) -> None:
        assert source_name_for_feed("The Neuron") == "the-neuron"
        assert source_name_for_feed("Ben's Bites") == "bens-bites"
        assert source_name_for_feed("There's An AI For That") == "theres-an-ai-for-that"
        assert source_name_for_feed("OpenAI Blog") == "openai-blog"


class TestAggregatorDetection:
    def test_single_publisher_feed_is_not_an_aggregator(self) -> None:
        urls = [f"https://openai.com/index/post-{i}/" for i in range(10)]
        assert not is_aggregator(urls)

    def test_one_syndicated_item_does_not_flip_a_publisher_feed(self) -> None:
        """Why the threshold is 3 and not 2."""
        urls = [f"https://openai.com/index/post-{i}/" for i in range(9)]
        urls.append("https://techcrunch.com/syndicated/")
        assert not is_aggregator(urls)

    def test_news_aggregator_is_detected(self) -> None:
        urls = [
            "https://www.bbc.com/news/a",
            "https://techcrunch.com/b",
            "https://finance.yahoo.com/c",
        ]
        assert len(urls) >= AGGREGATOR_DOMAIN_THRESHOLD
        assert is_aggregator(urls)

    def test_empty_feed_is_not_an_aggregator(self) -> None:
        assert not is_aggregator([])
        assert not is_aggregator(["", ""])


class TestRelevancePromptGenre:
    """The AI prompt is kept verbatim for the AI edition and must NOT be used for the others.

    ``newsletter_feed_sources_v2`` carries nine ``wasteland-wire`` fiction feeds (genre
    ``post-apocalyptic``). Judged by "Only AI and AI Adjacent content should be considered relevant"
    every one of their items is correctly rejected, which would silently discard that edition's
    whole corpus. n8n never hit this because n8n never polled those feeds.
    """

    def test_the_ai_prompt_is_unchanged(self) -> None:
        from writer_engine.ingestion.enrich import RELEVANCE_PROMPT, relevance_prompt_for

        for genre in ("", "ai", "AI", "ai-news", None):
            assert relevance_prompt_for(genre) == RELEVANCE_PROMPT

    def test_a_fiction_genre_gets_its_own_subject(self) -> None:
        from writer_engine.ingestion.enrich import relevance_prompt_for

        prompt = relevance_prompt_for("post-apocalyptic")
        assert "post apocalyptic newsletter" in prompt
        assert "Only post apocalyptic and closely adjacent content" in prompt
        # The AI-specific line must be gone, or the gate rejects the whole edition.
        assert "Only AI and AI Adjacent" not in prompt

    def test_the_structure_is_preserved(self) -> None:
        """Same shape as the baseline — bullet exclusions then the --- separator the body follows."""
        from writer_engine.ingestion.enrich import relevance_prompt_for

        prompt = relevance_prompt_for("metaphysical-romance")
        assert prompt.endswith("---\n")
        assert prompt.count("\n- ") >= 3
        assert "metaphysical romance" in prompt


class TestModalDomain:
    """The label for a single-publisher feed.

    It cannot come from the feed's name: ``/feeds/import-from-genre`` names every row it creates
    ``"<genre name> — RSS"``, so all nine live ``wasteland-wire`` RSS feeds share one name. Labelling
    by name filed Strange Horizons, Clarkesworld, Escape Pod and three Medium tags as the single
    source ``post-apocalyptic-science-fiction-rss`` — the wrong publisher on every row, and a key
    collision whenever two of those magazines publish the same title.
    """

    def test_the_dominant_domain_wins(self) -> None:
        from writer_engine.ingestion.sources import modal_domain

        urls = [
            "https://www.strangehorizons.com/fiction/a/",
            "https://www.strangehorizons.com/fiction/b/",
            "https://www.strangehorizons.com/reviews/c/",
            "https://www.amazon.com/dp/B0/",
        ]
        assert modal_domain(urls) == "strangehorizons"

    def test_each_wasteland_feed_gets_its_own_publisher(self) -> None:
        from writer_engine.ingestion.sources import modal_domain

        got = {
            modal_domain([f"https://clarkesworldmagazine.com/a_{i}/" for i in range(3)]),
            modal_domain([f"https://escapepod.org/2026/10/{i}/" for i in range(3)]),
            modal_domain([f"https://medium.com/p/{i}" for i in range(3)]),
        }
        assert got == {"clarkesworldmagazine", "escapepod", "medium"}

    def test_the_domain_map_still_applies(self) -> None:
        from writer_engine.ingestion.sources import modal_domain

        assert modal_domain(["https://finance.yahoo.com/a", "https://finance.yahoo.com/b"]) == "yahoo-finance"

    def test_no_usable_url_yields_nothing(self) -> None:
        from writer_engine.ingestion.sources import modal_domain

        assert modal_domain([]) == ""
        assert modal_domain(["", ""]) == ""
