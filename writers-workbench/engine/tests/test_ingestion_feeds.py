"""E1 — feed parsing, including the silent hole that made 7 of 32 live feeds produce nothing.

``DEV - Newsletter Ingestion (Multi-User Cron)`` normalized items with::

    const raw = Array.isArray(payload.items) ? payload.items : (Array.isArray(payload) ? payload : []);

which is true for a JSON Feed and false for every XML feed in ``newsletter_feed_sources_v2`` — the
beehiiv feed, four rss.app ``.xml`` feeds, and the Medium / Clarkesworld / Escape Pod / Strange
Horizons publisher feeds. Zero items is not an error, so it "succeeded" every 30 minutes.
"""

from __future__ import annotations

import json

import httpx
import pytest

from writer_engine.ingestion import feeds

JSON_FEED = {
    "version": "https://jsonfeed.org/version/1.1",
    "title": "OpenAI Blog",
    "items": [
        {
            "id": "1",
            "title": "Introducing a thing",
            "url": "https://openai.com/index/introducing-a-thing/",
            "date_published": "2026-10-16T17:00:00.000Z",
            "authors": [{"name": "OpenAI"}],
            "content_text": "Body text.",
            "content_html": "<p>Body text.</p>",
            "image": "https://openai.com/og.png",
        }
    ],
}

RSS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Clarkesworld</title>
    <item>
      <title>The Last Signal</title>
      <link>https://clarkesworldmagazine.com/author_10_26/</link>
      <pubDate>Fri, 17 Oct 2026 09:30:00 GMT</pubDate>
      <dc:creator>A. Writer</dc:creator>
      <description>&lt;p&gt;A short teaser.&lt;/p&gt;</description>
      <content:encoded>&lt;p&gt;The whole story, all of it.&lt;/p&gt;</content:encoded>
      <media:content url="https://clarkesworldmagazine.com/cover.jpg" type="image/jpeg"/>
    </item>
  </channel>
</rss>
"""

ATOM_XML = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>A Blog</title>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" href="https://example.com/post"/>
    <link rel="edit" href="https://example.com/edit"/>
    <published>2026-10-15T08:00:00Z</published>
    <author><name>Someone</name></author>
    <content type="html">&lt;p&gt;Atom body.&lt;/p&gt;</content>
  </entry>
</feed>
"""


def _reddit_listing(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "title": "Anyone else noticing this?",
        "permalink": "/r/artificial/comments/abc123/anyone_else/",
        "created_utc": 1_792_000_000,
        "author": "someuser",
        "is_self": True,
        "selftext": "I have been running the model locally and...",
        "selftext_html": "&lt;p&gt;I have been running the model locally and...&lt;/p&gt;",
        "score": 42,
        "num_comments": 7,
        "subreddit": "artificial",
        "id": "abc123",
        "link_flair_text": "Discussion",
    }
    data.update(overrides)
    return {"data": {"children": [{"data": data}]}}


class TestSniff:
    def test_json_body(self) -> None:
        assert feeds.sniff('{"items": []}') == "json"
        assert feeds.sniff("[1,2]") == "json"

    def test_xml_body(self) -> None:
        assert feeds.sniff(RSS_XML) == "xml"

    def test_content_type_wins_when_body_is_odd(self) -> None:
        assert feeds.sniff("  \n  not markup", "application/json; charset=utf-8") == "json"
        assert feeds.sniff("  \n  not markup", "application/rss+xml") == "xml"

    def test_unknown(self) -> None:
        assert feeds.sniff("plain prose", "text/plain") == "unknown"


class TestJsonFeed:
    def test_fields(self) -> None:
        items = feeds.parse_json_feed(JSON_FEED)
        assert len(items) == 1
        item = items[0]
        assert item.title == "Introducing a thing"
        assert item.url == "https://openai.com/index/introducing-a-thing/"
        assert item.authors == "OpenAI"
        assert item.published == "2026-10-16T17:00:00.000Z"
        assert item.body_text == "Body text."
        assert item.image_urls == ["https://openai.com/og.png"]

    def test_tolerates_junk_entries(self) -> None:
        assert feeds.parse_json_feed({"items": ["nope", None, 3]}) == []


class TestRssXml:
    def test_rss_2_0(self) -> None:
        items = feeds.parse_rss_xml(RSS_XML)
        assert len(items) == 1
        item = items[0]
        assert item.title == "The Last Signal"
        assert item.url == "https://clarkesworldmagazine.com/author_10_26/"
        assert item.authors == "A. Writer"
        # content:encoded beats description — that is the full post versus the teaser.
        assert item.body_html == "<p>The whole story, all of it.</p>"
        assert item.body_text == "The whole story, all of it."
        assert item.image_urls == ["https://clarkesworldmagazine.com/cover.jpg"]

    def test_atom(self) -> None:
        items = feeds.parse_rss_xml(ATOM_XML)
        assert len(items) == 1
        assert items[0].title == "Atom entry"
        # rel="alternate", not the rel="edit" link that appears after it.
        assert items[0].url == "https://example.com/post"
        assert items[0].body_text == "Atom body."

    def test_malformed_xml_yields_no_items_rather_than_raising(self) -> None:
        """A feed serving an HTML error page must cost one feed's run, not the whole tick."""
        assert feeds.parse_rss_xml("<html><body>502 Bad Gateway") == []


class TestRedditListing:
    def test_self_post(self) -> None:
        items = feeds.parse_reddit_listing(_reddit_listing())
        assert len(items) == 1
        item = items[0]
        assert item.is_self_post
        assert item.item_type == feeds.REDDIT_POST
        assert item.url == "https://reddit.com/r/artificial/comments/abc123/anyone_else/"
        assert item.body_text.startswith("I have been running")
        assert item.body_html == "<p>I have been running the model locally and...</p>"
        assert item.reddit == {
            "score": 42,
            "num_comments": 7,
            "author": "someuser",
            "subreddit": "artificial",
            "reddit_id": "abc123",
            "flair": "Discussion",
        }

    def test_link_post_points_at_the_destination(self) -> None:
        """A link post's body lives on the destination site, so that is what gets scraped and what
        names the publisher — the n8n ``route_scrape_or_self`` split."""
        items = feeds.parse_reddit_listing(
            _reddit_listing(
                is_self=False,
                selftext="",
                url_overridden_by_dest="https://techcrunch.com/2026/10/17/thing/",
            )
        )
        assert items[0].url == "https://techcrunch.com/2026/10/17/thing/"
        assert items[0].is_self_post is False
        assert items[0].item_type == feeds.ARTICLE

    def test_post_page_array_shape(self) -> None:
        """``/comments/<id>.json`` returns [post_listing, comment_listing]."""
        items = feeds.parse_reddit_listing([_reddit_listing(), {"data": {"children": []}}])
        assert len(items) == 1

    def test_unexpected_shape(self) -> None:
        assert feeds.parse_reddit_listing({"error": 404}) == []


class TestUnscrapeable:
    @pytest.mark.parametrize(
        "url",
        [
            "https://www.youtube.com/watch?v=x",
            "https://youtu.be/x",
            "https://i.redd.it/x.png",
            "https://v.redd.it/x",
            "https://github.com/org/repo",
            "https://x.com/someone/status/1",
            "https://reddit.com/r/x/comments/y/",
            "",
        ],
    )
    def test_rejected(self, url: str) -> None:
        assert not feeds.is_scrapeable_destination(url)

    def test_accepted(self) -> None:
        assert feeds.is_scrapeable_destination("https://techcrunch.com/2026/10/17/thing/")


class TestFetch:
    """``fetch_feed`` picks the parser from the body, which is the fix for the 7 dead XML feeds."""

    @staticmethod
    def _client(body: str, content_type: str) -> httpx.AsyncClient:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text=body, headers={"content-type": content_type})

        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    @pytest.mark.asyncio
    async def test_xml_feed_declared_rss_yields_items(self) -> None:
        async with self._client(RSS_XML, "application/rss+xml") as client:
            items = await feeds.fetch_feed(
                "https://clarkesworldmagazine.com/feed/", url_type="rss", client=client
            )
        assert [i.title for i in items] == ["The Last Signal"]

    @pytest.mark.asyncio
    async def test_json_feed_declared_rss_yields_items(self) -> None:
        async with self._client(json.dumps(JSON_FEED), "application/json") as client:
            items = await feeds.fetch_feed(
                "https://rss.app/feeds/v1.1/6BnoYYEtnCHXfHj0.json", url_type="rss", client=client
            )
        assert [i.title for i in items] == ["Introducing a thing"]

    @pytest.mark.asyncio
    async def test_reddit_url_type_serving_a_json_feed(self) -> None:
        """The three ai-news ``reddit`` rows point at rss.app JSON feeds, not at Reddit."""
        async with self._client(json.dumps(JSON_FEED), "application/json") as client:
            items = await feeds.fetch_feed(
                "https://rss.app/feeds/v1.1/upLgfm9lv7RXwzes.json", url_type="reddit", client=client
            )
        assert len(items) == 1
        # Not reddit_post: an rss.app subreddit entry has no is_self, so it is resolved later.
        assert items[0].item_type == feeds.ARTICLE

    @pytest.mark.asyncio
    async def test_reddit_url_type_serving_a_listing(self) -> None:
        """The four wasteland-wire ``reddit`` rows point at ``/r/<x>/.json``."""
        async with self._client(json.dumps(_reddit_listing()), "application/json") as client:
            items = await feeds.fetch_feed(
                "https://www.reddit.com/r/artificial/.json", url_type="reddit", client=client
            )
        assert len(items) == 1 and items[0].is_self_post

    @pytest.mark.asyncio
    async def test_non_2xx_raises_so_the_feed_row_records_it(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="upstream down")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(httpx.HTTPStatusError):
                await feeds.fetch_feed("https://example.com/feed", client=client)

    @pytest.mark.asyncio
    async def test_sends_the_reddit_tolerated_user_agent(self) -> None:
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["ua"] = request.headers.get("user-agent", "")
            return httpx.Response(200, text="{}", headers={"content-type": "application/json"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await feeds.fetch_feed("https://www.reddit.com/r/x/.json", url_type="reddit", client=client)
        assert seen["ua"] == feeds.USER_AGENT


class TestFetchRedditPost:
    @pytest.mark.asyncio
    async def test_follows_a_permalink_to_the_full_record(self) -> None:
        requested: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requested.append(str(request.url))
            return httpx.Response(
                200,
                text=json.dumps([_reddit_listing(), {"data": {"children": []}}]),
                headers={"content-type": "application/json"},
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            item = await feeds.fetch_reddit_post(
                "https://reddit.com/r/artificial/comments/abc123/anyone_else/", client=client
            )
        assert item is not None and item.is_self_post
        assert requested == ["https://www.reddit.com/comments/abc123.json?raw_json=1"]

    @pytest.mark.asyncio
    async def test_non_thread_url_is_skipped_without_a_request(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
            raise AssertionError("should not fetch")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            assert await feeds.fetch_reddit_post("https://example.com/post", client=client) is None

    @pytest.mark.asyncio
    async def test_a_dead_thread_returns_none_rather_than_raising(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="not found")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            assert (
                await feeds.fetch_reddit_post("https://reddit.com/r/x/comments/gone/t/", client=client)
                is None
            )


def test_entity_decoding_is_limited_to_reddits_set() -> None:
    assert feeds.decode_entities("a &amp; b &lt;x&gt; &quot;q&quot; &#039;s&#039;") == "a & b <x> \"q\" 's'"
    # Not html.unescape: a numeric entity outside the set stays literal.
    assert feeds.decode_entities("&#9731;") == "&#9731;"


class TestCodeElementStripping:
    """Measured on the first live DEV run: a Strange Horizons story whose ``content:encoded`` opens
    with an inline content-warning widget was stored as 39KB of markdown beginning
    ``function showWarning_enUS() { var content_warning_list = document.`` — JavaScript filed as the
    body of a short story, which is then what the newsletter would have summarised."""

    SCRIPTED = (
        "<script> function showWarning_enUS() { var x = document.getElementById('w'); } </script>"
        "<p>The real story begins here.</p>"
        "<style>.warning { display: none; }</style>"
    )

    def test_script_and_style_contents_are_removed_from_text(self) -> None:
        text = feeds.strip_html(self.SCRIPTED)
        assert "The real story begins here." in text
        assert "showWarning_enUS" not in text
        assert "display: none" not in text

    def test_script_contents_are_removed_from_the_html_blob_too(self) -> None:
        html = feeds.strip_code_elements(self.SCRIPTED)
        assert "<p>The real story begins here.</p>" in html
        assert "showWarning_enUS" not in html

    def test_an_unclosed_script_is_still_removed(self) -> None:
        """A truncated feed body would otherwise slip the whole tail through."""
        assert "alert" not in feeds.strip_html("<p>Prose.</p><script>alert(1)")

    def test_rss_parsing_applies_it(self) -> None:
        xml = (
            '<?xml version="1.0"?><rss version="2.0"><channel><item>'
            "<title>Story</title><link>https://example.com/s</link>"
            "<description>&lt;script&gt;var leak = 1;&lt;/script&gt;&lt;p&gt;Prose.&lt;/p&gt;</description>"
            "</item></channel></rss>"
        )
        item = feeds.parse_rss_xml(xml)[0]
        assert "leak" not in item.body_text and "leak" not in item.body_html
        assert "Prose." in item.body_text

    def test_a_script_free_body_is_unchanged(self) -> None:
        assert feeds.strip_code_elements("<p>Just prose.</p>") == "<p>Just prose.</p>"


class TestRedditRssSelfPosts:
    """Reddit 403s its own `/.json` listing from a datacenter IP but serves `/.rss` from the same
    address, so all four wasteland-wire subreddit rows were recorded as dead feeds when the endpoint
    was the problem. Switching them to `/.rss` fetches — but without this marking, 24 of 25 items
    were skipped as unscrapeable, because the Atom path never set `is_self_post`, a self post is far
    under INLINE_BODY_MIN_WORDS, and reddit.com is on the unscrapeable list. Measured live."""

    ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>And if biblical apocalypse was about the end of the dragon age</title>
    <link href="https://www.reddit.com/r/apocalypse/comments/abc123/and_if/"/>
    <content type="html">&lt;div&gt;The flood narrative reads differently if you take the serpents literally.&lt;/div&gt;</content>
    <published>2026-09-10T12:00:00+00:00</published>
    <author><name>/u/someone</name></author>
  </entry>
  <entry>
    <title>A link post to an outside article</title>
    <link href="https://example.com/an-article"/>
    <content type="html">&lt;a href="https://example.com/an-article"&gt;[link]&lt;/a&gt; submitted by /u/someone&lt;/a&gt;</content>
    <published>2026-09-10T13:00:00+00:00</published>
  </entry>
</feed>"""

    def test_a_reddit_atom_entry_with_a_body_is_a_self_post(self) -> None:
        items = feeds._mark_reddit_rss_self_posts(
            feeds.parse_rss_xml(self.ATOM), feed_url="https://www.reddit.com/r/apocalypse/.rss"
        )
        selfpost = items[0]
        assert selfpost.is_self_post is True
        assert selfpost.item_type == feeds.REDDIT_POST
        assert "serpents literally" in selfpost.body_text

    def test_a_link_post_is_left_alone_so_it_still_gets_scraped(self) -> None:
        """Its destination is scrapeable and its body is a stub, so marking it a self post would
        ingest the stub instead of the article."""
        items = feeds._mark_reddit_rss_self_posts(
            feeds.parse_rss_xml(self.ATOM), feed_url="https://www.reddit.com/r/apocalypse/.rss"
        )
        assert items[1].is_self_post is False

    def test_a_non_reddit_feed_is_untouched(self) -> None:
        """Clarkesworld and Medium syndicate full bodies too; they must keep going down the normal
        inline-body path, which applies the relevance gate."""
        items = feeds._mark_reddit_rss_self_posts(
            feeds.parse_rss_xml(self.ATOM), feed_url="https://clarkesworldmagazine.com/feed/"
        )
        assert [i.is_self_post for i in items] == [False, False]

    def test_an_rss_app_mirror_is_not_a_reddit_feed(self) -> None:
        """rss.app's subreddit mirrors carry link posts and no bodies; they are handled by the JSON
        path and must not be swept in by host matching."""
        assert feeds.is_reddit_feed("https://rss.app/feeds/v1.1/upLgfm9lv7RXwzes.json") is False
        assert feeds.is_reddit_feed("https://www.reddit.com/r/apocalypse/.rss") is True
