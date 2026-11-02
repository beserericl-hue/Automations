"""ScraperAPI + trafilatura (writer_engine.scraping), which replaced Firecrawl 2026-11-01.

Every test runs against an httpx MockTransport standing in for ScraperAPI, so nothing is billed.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest

from writer_engine import scraping
from writer_engine.config import get_settings

ARTICLE_BODY = " ".join(
    f"Paragraph {n} of the article explains what the new model release changes for developers."
    for n in range(12)
)

ARTICLE = f"""<!doctype html><html><head><title>The real headline</title></head><body>
<nav><a href="/">Home</a> <a href="/subscribe?ref=nav">Subscribe now</a></nav>
<header><img src="/static/logo.png" width="120"></header>
<article>
<h1>The real headline</h1>
<p>{ARTICLE_BODY}</p>
<p><img src="https://cdn.example.com/hero.jpg" width="1200" alt="Hero"></p>
<p><img src="https://cdn.example.com/inline-small.jpg" width="300" alt="Thumb"></p>
<p><img src="https://cdn.example.com/thumb.jpg?w=160&strip=all" alt="Query-sized thumb"></p>
<p>Read the <a href="https://openai.com/blog/announcement?utm_source=x">announcement</a>.</p>
</article>
<footer>Copyright footer text. Sign up for our newsletter today!</footer>
</body></html>"""

JS_SHELL = (
    '<html><head><title>App</title></head><body><div id="root"></div><script>x()</script></body></html>'
)


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("SCRAPERAPI_API_KEY", "sapi-test-key-123456")
    monkeypatch.setenv("SCRAPER_ENABLED", "true")
    monkeypatch.setenv("SCRAPER_RENDER_FALLBACK", "true")
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:1/0")
    get_settings.cache_clear()
    from writer_engine.rate_limit.provider_budget import reset_shared_budget

    reset_shared_budget()
    yield
    get_settings.cache_clear()
    reset_shared_budget()


def _client(pages: dict[bool, tuple[int, str]], seen: list[httpx.Request]) -> httpx.AsyncClient:
    """ScraperAPI stand-in: ``pages[render]`` is the (status, html) for a plain or rendered fetch."""

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        render = request.headers.get("x-sapi-render") == "true" or request.url.params.get("render") == "true"
        status, html = pages[render]
        return httpx.Response(status, text=html, headers={"sa-credit-cost": "10" if render else "1"})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestFetch:
    async def test_the_key_travels_in_a_header_never_in_the_url(self) -> None:
        """httpx writes the request URL into every HTTPStatusError, and those strings are stored."""
        seen: list[httpx.Request] = []
        async with _client({False: (200, ARTICLE)}, seen) as client:
            page = await scraping.fetch_page("https://news.example.com/story", client=client)
        assert page.ok
        req = seen[0]
        assert req.headers["x-sapi-api_key"] == "sapi-test-key-123456"
        assert "sapi-test-key" not in str(req.url)
        assert req.url.params["url"] == "https://news.example.com/story"

    async def test_a_failed_fetch_does_not_leak_the_key_into_the_error(self) -> None:
        seen: list[httpx.Request] = []
        async with _client({False: (401, "bad key")}, seen) as client:
            page = await scraping.fetch_page("https://news.example.com/story", client=client)
        assert not page.ok
        assert "401" in page.error
        assert "sapi-test-key" not in page.error

    async def test_the_main_body_is_kept_and_the_page_chrome_is_not(self) -> None:
        seen: list[httpx.Request] = []
        async with _client({False: (200, ARTICLE)}, seen) as client:
            page = await scraping.fetch_page("https://news.example.com/story", client=client)
        assert "Paragraph 11 of the article" in page.markdown
        assert "Subscribe now" not in page.markdown
        assert "Copyright footer" not in page.markdown
        assert page.title == "The real headline"
        assert page.credits == 1
        assert not page.rendered
        assert len(seen) == 1, "a readable page must not pay for a rendered fetch"

    async def test_links_are_absolute_and_images_skip_logos_and_narrow_ones(self) -> None:
        seen: list[httpx.Request] = []
        async with _client({False: (200, ARTICLE)}, seen) as client:
            page = await scraping.fetch_page("https://news.example.com/story", client=client)
        assert "https://news.example.com/subscribe?ref=nav" in page.links
        assert "https://openai.com/blog/announcement?utm_source=x" in page.links
        assert page.image_urls == ["https://cdn.example.com/hero.jpg"]

    async def test_a_javascript_shell_is_fetched_once_more_rendered(self) -> None:
        seen: list[httpx.Request] = []
        async with _client({False: (200, JS_SHELL), True: (200, ARTICLE)}, seen) as client:
            page = await scraping.fetch_page("https://app.example.com/post", client=client)
        assert page.ok and page.rendered
        assert page.credits == 11
        assert [r.url.params.get("render") for r in seen] == [None, "true"]

    async def test_the_rendered_fallback_can_be_switched_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SCRAPER_RENDER_FALLBACK", "false")
        get_settings.cache_clear()
        seen: list[httpx.Request] = []
        async with _client({False: (200, JS_SHELL), True: (200, ARTICLE)}, seen) as client:
            page = await scraping.fetch_page("https://app.example.com/post", client=client)
        assert page.error == "no_main_content"
        assert len(seen) == 1

    async def test_a_404_is_not_retried(self) -> None:
        """ScraperAPI bills a 404; retrying it pays again for the same answer."""
        seen: list[httpx.Request] = []
        async with _client({False: (404, "gone")}, seen) as client:
            page = await scraping.fetch_page("https://news.example.com/gone", client=client)
        assert "404" in page.error
        assert len(seen) == 1

    async def test_a_500_gets_exactly_one_retry(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A 500 means ScraperAPI already retried for 70s; four more rounds would be minutes."""
        import writer_engine.rate_limit.retry as retry_mod

        async def _no_sleep(_: float) -> None:
            return None

        monkeypatch.setattr(retry_mod.asyncio, "sleep", _no_sleep)
        seen: list[httpx.Request] = []
        async with _client({False: (500, "failed")}, seen) as client:
            page = await scraping.fetch_page("https://news.example.com/hard", client=client)
        assert "500" in page.error
        assert len(seen) == scraping.FETCH_ATTEMPTS == 2


class TestAvailability:
    async def test_no_key_and_switched_off_both_skip_the_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SCRAPER_ENABLED", "false")
        get_settings.cache_clear()
        assert not scraping.scraper_available()
        assert (await scraping.fetch_page("https://x.example.com")).error == "scraper_disabled"

        monkeypatch.setenv("SCRAPER_ENABLED", "true")
        monkeypatch.setenv("SCRAPERAPI_API_KEY", "")
        get_settings.cache_clear()
        assert not scraping.scraper_available()
        assert (await scraping.fetch_page("https://x.example.com")).error == "scraper_not_configured"


class TestScrapeStep:
    async def test_one_slow_url_does_not_take_the_others_down(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import asyncio
        from uuid import uuid4

        from scrape_step import main as scrape_main

        from writer_engine.schemas import StepInput

        async def _fetch(url: str, *, client: object = None) -> scraping.Page:
            if "slow" in url:
                await asyncio.sleep(5)
            return scraping.Page(url=url, markdown=f"body of {url}", title="t")

        monkeypatch.setattr(scrape_main, "fetch_page", _fetch)
        monkeypatch.setattr(scrape_main, "URL_DEADLINE_S", 0.2)
        out = await scrape_main.handler(
            StepInput(
                execution_id=uuid4(),
                step_name="scrape",
                payload={
                    "urls": ["https://a.example.com", "https://slow.example.com", "https://b.example.com"]
                },
            )
        )
        assert [s["url"] for s in out.payload["scraped"]] == [
            "https://a.example.com",
            "https://b.example.com",
        ]
        assert out.payload["errors"] == [{"url": "https://slow.example.com", "error": "TimeoutError"}]
