"""scrape-svc — fetch supplemental source URLs (Firecrawl) with per-URL error filtering."""

from __future__ import annotations

import httpx

from writer_engine.config import get_settings
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "scrape"


async def _firecrawl(url: str, key: str) -> dict[str, str]:
    """Single-URL scrape against Firecrawl v1."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.firecrawl.dev/v1/scrape",
            headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
            json={"url": url, "formats": ["markdown"]},
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "url": url,
            "markdown": (data.get("data") or {}).get("markdown") or "",
            "title": ((data.get("data") or {}).get("metadata") or {}).get("title") or "",
        }


async def handler(inp: StepInput) -> StepOutput:
    urls = [str(u) for u in (inp.payload.get("urls") or []) if u]
    settings = get_settings()
    scraped: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    if not settings.firecrawl_api_key:
        # Fixture: echo the URLs back without content so downstream still wires.
        scraped = [{"url": u, "markdown": "(scrape provider not configured)", "title": ""} for u in urls]
    else:
        for url in urls:
            try:
                scraped.append(await _firecrawl(url, settings.firecrawl_api_key))
            except Exception as exc:
                errors.append({"url": url, "error": type(exc).__name__})
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"scraped": scraped, "errors": errors, "count": len(scraped)},
    )


app = build_step_app(STEP_NAME, handler)
