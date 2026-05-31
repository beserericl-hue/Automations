"""Sanity check — verifies every provider key + connectivity through the engine library.

Run with: ``uv run python scripts/sanity_check.py``
"""

from __future__ import annotations

import asyncio
import time

import httpx

from writer_engine.config import get_settings
from writer_engine.llm.factory import get_router, reset_router

PLACEHOLDERS = {
    "SERVICE_SHARED_SECRET": "dev-service-secret-change-me",
    "ADMIN_TOKEN": "dev-admin-token-change-me",
    "ARCHIVE_BASE_URL": "https://archive.example.com",
}


def _status(name: str, value: str) -> str:
    if not value:
        return "❌ MISSING"
    if PLACEHOLDERS.get(name) == value:
        return "⚠ placeholder"
    return f"✓ set ({len(value)} chars)"


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def print_keys() -> None:
    s = get_settings()
    section("Key status (engine/.env)")
    pairs = [
        ("ANTHROPIC_API_KEY", s.anthropic_api_key),
        ("GEMINI_API_KEY", s.gemini_api_key),
        ("PERPLEXITY_API_KEY", s.perplexity_api_key),
        ("OPENAI_API_KEY", s.openai_api_key),
        ("FIRECRAWL_API_KEY", s.firecrawl_api_key),
        ("KIEAI_API_KEY", s.kieai_api_key),
        ("POSTAL_API_KEY", s.postal_api_key),
        ("POSTAL_API_URL", s.postal_api_url),
        ("SUPABASE_URL", s.supabase_url),
        ("SUPABASE_SERVICE_ROLE_KEY", s.supabase_service_role_key),
        ("REDIS_URL", s.redis_url),
        ("INGESTION_SECRET", s.ingestion_secret),
        ("WORKBENCH_API_URL", s.workbench_api_url),
        ("SERVICE_SHARED_SECRET", s.service_shared_secret),
        ("ADMIN_TOKEN", s.admin_token),
        ("ARCHIVE_BASE_URL", s.archive_base_url),
        ("PICKER_MODEL", s.picker_model),
    ]
    width = max(len(k) for k, _ in pairs)
    for k, v in pairs:
        print(f"  {k:<{width}}  {_status(k, v)}")


async def probe_anthropic(timeout: float = 30.0) -> str:
    reset_router()
    router = get_router(service="sanity")
    t = time.perf_counter()
    resp = await asyncio.wait_for(
        router.complete(
            provider="anthropic",
            model="claude-haiku-4-5",
            system="You are a probe. Answer in 1 word.",
            prompt="ping",
            max_tokens=10,
            temperature=0,
        ),
        timeout=timeout,
    )
    return f"{resp.text.strip()!r} ({resp.input_tokens}→{resp.output_tokens} tok, {time.perf_counter() - t:.2f}s)"


async def probe_gemini(timeout: float = 30.0) -> str:
    router = get_router(service="sanity")
    t = time.perf_counter()
    # Gemini 2.5 Pro uses internal thinking tokens; need a generous max_tokens so a Part comes back.
    resp = await asyncio.wait_for(
        router.complete(
            provider="gemini",
            model=get_settings().picker_model,
            system="You are a probe. Answer in 1 word.",
            prompt="ping",
            max_tokens=4000,
            temperature=0,
        ),
        timeout=timeout,
    )
    return f"{resp.text.strip()!r} ({resp.input_tokens}→{resp.output_tokens} tok, {time.perf_counter() - t:.2f}s)"


async def probe_perplexity(timeout: float = 30.0) -> str:
    """Try a few model names; Perplexity renames them periodically."""
    s = get_settings()
    last_err = ""
    for model in ("sonar", "sonar-pro", "llama-3.1-sonar-small-128k-online"):
        try:
            t = time.perf_counter()
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    "https://api.perplexity.ai/chat/completions",
                    headers={"authorization": f"Bearer {s.perplexity_api_key}", "content-type": "application/json"},
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 20,
                        "temperature": 0,
                    },
                )
            if resp.status_code >= 300:
                last_err = f"{model}: {resp.status_code} {resp.text[:160]}"
                continue
            body = resp.json()
            text = body["choices"][0]["message"]["content"]
            usage = body.get("usage", {})
            return (
                f"model={model} {text.strip()[:60]!r} "
                f"({usage.get('prompt_tokens')}→{usage.get('completion_tokens')} tok, {time.perf_counter() - t:.2f}s)"
            )
        except Exception as exc:
            last_err = f"{model}: {type(exc).__name__}: {str(exc)[:160]}"
    raise RuntimeError(f"all Perplexity models failed; last error: {last_err}")


async def probe_openai(timeout: float = 30.0) -> str:
    """OpenAI: no engine adapter yet, so probe the raw API directly to confirm the key works."""
    key = get_settings().openai_api_key
    t = time.perf_counter()
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5,
            },
        )
    resp.raise_for_status()
    body = resp.json()
    text = body["choices"][0]["message"]["content"]
    usage = body.get("usage", {})
    return f"{text!r} ({usage.get('prompt_tokens')}→{usage.get('completion_tokens')} tok, {time.perf_counter() - t:.2f}s)"


async def probe_firecrawl(timeout: float = 30.0) -> str:
    key = get_settings().firecrawl_api_key
    t = time.perf_counter()
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            "https://api.firecrawl.dev/v1/scrape",
            headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
            json={"url": "https://example.com", "formats": ["markdown"]},
        )
    resp.raise_for_status()
    data = resp.json()
    md = (data.get("data") or {}).get("markdown") or ""
    return f"scraped example.com ({len(md)} md chars, {time.perf_counter() - t:.2f}s)"


async def probe_supabase(timeout: float = 30.0) -> str:
    s = get_settings()
    t = time.perf_counter()
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(
            f"{s.supabase_url}/rest/v1/content_ingestion_v2",
            params={"select": "id", "limit": "1"},
            headers={"apikey": s.supabase_service_role_key, "authorization": f"Bearer {s.supabase_service_role_key}"},
        )
    resp.raise_for_status()
    rows = resp.json()
    return f"http {resp.status_code}, {len(rows)} row sample, {time.perf_counter() - t:.2f}s"


async def probe_postal(timeout: float = 15.0) -> str:
    """Probe a few possible Postal endpoint paths to find the real one.

    Postal's send endpoint is ``/api/v1/send/message``; some deployments mount the API on a separate hostname or at
    a versioned root. We try a handful and report what auths.
    """
    s = get_settings()
    base = s.postal_api_url.rstrip("/")
    candidates = [
        f"{base}/api/v1/send/message",
        f"{base}/api/v1/send/raw_message",
        f"{base}/send/message",
    ]
    body = {
        "to": ["__sanity__@example.invalid"],
        "from": "probe@example.invalid",
        "subject": "probe",
        "html_body": "<p>probe</p>",
    }
    results: list[str] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for url in candidates:
            try:
                t = time.perf_counter()
                resp = await client.post(
                    url,
                    headers={"x-server-api-key": s.postal_api_key, "content-type": "application/json"},
                    json=body,
                )
                snippet = (resp.text or "")[:60].replace("\n", " ")
                results.append(f"{url.replace(base, '<base>')} → {resp.status_code} ({snippet}, {time.perf_counter() - t:.2f}s)")
            except Exception as exc:
                results.append(f"{url.replace(base, '<base>')} → {type(exc).__name__}: {str(exc)[:80]}")
    return "\n      ".join(results)


async def probe_pick_step() -> str:
    """End-to-end: actually call the pick-step handler with a tiny corpus and real Gemini."""
    from pick_step.main import handler
    from writer_engine.schemas import StepInput
    from uuid import uuid4

    articles = [
        {"id": "a1", "title": "Anthropic launches Claude 5", "source_name": "tech-daily"},
        {"id": "a2", "title": "OpenAI's new reasoning model leaks", "source_name": "wire-report"},
        {"id": "a3", "title": "EU AI Act enforcement begins", "source_name": "bloomberg"},
        {"id": "a4", "title": "Local pizza shop opens", "source_name": "small-town-news"},
    ]
    t = time.perf_counter()
    out = await handler(
        StepInput(execution_id=uuid4(), step_name="pick", payload={"articles": articles, "max_stories": 2})
    )
    if out.status.value != "ok":
        return f"❌ status={out.status.value} error={out.error}"
    picked = out.payload.get("top_selected_stories", [])
    titles = ", ".join(s.get("title", "?") for s in picked)
    return f"picked {len(picked)} stories via Gemini ({titles!r}), {time.perf_counter() - t:.2f}s"


async def main() -> None:
    print_keys()

    probes = [
        ("Anthropic claude-haiku-4-5", probe_anthropic),
        ("Gemini " + get_settings().picker_model, probe_gemini),
        ("Perplexity sonar", probe_perplexity),
        ("OpenAI gpt-4o-mini", probe_openai),
        ("Firecrawl scrape", probe_firecrawl),
        ("Supabase DEV content_ingestion_v2", probe_supabase),
        ("Postal /api/v1/send/message reachability", probe_postal),
        ("pick-step (Gemini end-to-end)", probe_pick_step),
    ]

    section("Live provider probes")
    for label, fn in probes:
        try:
            res = await fn()
            print(f"  ✓ {label}\n      {res}")
        except Exception as exc:
            print(f"  ❌ {label}\n      {type(exc).__name__}: {str(exc)[:180]}")


if __name__ == "__main__":
    asyncio.run(main())
