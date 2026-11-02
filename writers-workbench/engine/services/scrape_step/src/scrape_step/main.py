"""scrape-svc — fetch supplemental source URLs (ScraperAPI) with per-URL error filtering."""

from __future__ import annotations

import asyncio

import httpx

from writer_engine.config import get_settings
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.scraping import FETCH_TIMEOUT_S, fetch_page
from writer_engine.step_service import build_step_app

STEP_NAME = "scrape"

URL_DEADLINE_S = 120.0
"""One URL's whole budget, retries and the rendered fallback included. The newsletter saga gives this
step 180s, so the URLs run side by side and each is cut off inside that, rather than one hanging page
taking every other source of the story down with it."""


async def handler(inp: StepInput) -> StepOutput:
    urls = [str(u) for u in (inp.payload.get("urls") or []) if u]
    settings = get_settings()
    scraped: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    if not settings.scraperapi_api_key:
        # Fixture: echo the URLs back without content so downstream still wires.
        scraped = [{"url": u, "markdown": "(scrape provider not configured)", "title": ""} for u in urls]
    else:
        # B8: a newsletter fans this out once per story; fetch_page goes through the shared
        # scraperapi budget and its retry.
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S) as client:

            async def _one(url: str) -> tuple[str, str, str]:
                try:
                    page = await asyncio.wait_for(fetch_page(url, client=client), URL_DEADLINE_S)
                except TimeoutError:
                    return url, "", "TimeoutError"
                return url, page.markdown if not page.error else "", page.error or page.title

            for url, markdown, detail in await asyncio.gather(*(_one(u) for u in urls)):
                if markdown:
                    scraped.append({"url": url, "markdown": markdown, "title": detail})
                else:
                    errors.append({"url": url, "error": detail.split(":", 1)[0]})
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"scraped": scraped, "errors": errors, "count": len(scraped)},
    )


app = build_step_app(STEP_NAME, handler)
