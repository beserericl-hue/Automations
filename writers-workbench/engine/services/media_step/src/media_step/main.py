"""media-step — cover-art / social-posts / scrape-url.

cover-art generates a book cover via KIE.AI (google/nano-banana), falls back to OpenAI DALL-E 3,
and persists the image to Supabase Storage (``cover-images`` bucket) — mirroring the n8n
``Generate Cover Art`` workflow. scrape-url calls Firecrawl. social-posts runs craft-composed
generation. Every op fixture-falls back when its provider/key is absent so the service still boots.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from datetime import UTC

import httpx

from writer_engine.config import get_settings
from writer_engine.llm import ProviderNotRegistered, get_router
from writer_engine.llm.structured import extract_json
from writer_engine.prompt_store import compose_craft_system, seed_default_prompts
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "media"
seed_default_prompts()

_KIEAI_CREATE = "https://api.kie.ai/api/v1/playground/createTask"
_KIEAI_RECORD = "https://api.kie.ai/api/v1/playground/recordInfo"
_OPENAI_IMAGES = "https://api.openai.com/v1/images/generations"


def _slug(text: str) -> str:
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", str(text).lower()))[:60] or "cover"


def _cover_prompt(payload: dict) -> str:
    """Build the image prompt from the work's title/genre/summary (mirrors n8n build_prompt)."""
    title = str(payload.get("title") or "Untitled")
    genre = str(payload.get("genre_slug") or payload.get("genre") or "")
    summary = str(payload.get("summary") or payload.get("premise") or "")
    parts = [
        f"Professional book cover illustration for the novel \"{title}\"",
        f"a {genre} novel" if genre else "",
        summary[:400],
        "evocative, atmospheric, high detail, dramatic lighting, portrait orientation, "
        "no text, no lettering, no title overlay",
    ]
    return ". ".join(p for p in parts if p)


async def _kieai_cover(prompt: str, *, key: str, timeout_s: int = 180) -> bytes | None:
    """KIE.AI google/nano-banana: createTask -> poll recordInfo (state==success) -> download bytes."""
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    body = {"model": "google/nano-banana", "callBackUrl": "", "input": {"prompt": prompt, "image_urls": []}}
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            r = await client.post(_KIEAI_CREATE, headers=headers, json=body)
            r.raise_for_status()
            task_id = (r.json().get("data") or {}).get("taskId")
            if not task_id:
                return None
            deadline = timeout_s
            waited = 0
            while waited < deadline:
                await asyncio.sleep(5)
                waited += 5
                pr = await client.get(_KIEAI_RECORD, headers=headers, params={"taskId": task_id})
                pr.raise_for_status()
                data = pr.json().get("data") or {}
                state = data.get("state")
                if state == "success":
                    result = json.loads(data.get("resultJson") or "{}")
                    urls = result.get("resultUrls") or []
                    if not urls:
                        return None
                    img = await client.get(urls[0])
                    img.raise_for_status()
                    return img.content
                if state in ("fail", "error"):
                    return None
            return None
        except Exception:
            return None


async def _dalle_cover(prompt: str, *, key: str) -> bytes | None:
    """OpenAI DALL-E 3 fallback — portrait book-cover size, returned as bytes."""
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    body = {"model": "dall-e-3", "prompt": prompt[:3900], "size": "1024x1792", "n": 1,
            "response_format": "b64_json"}
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            r = await client.post(_OPENAI_IMAGES, headers=headers, json=body)
            r.raise_for_status()
            b64 = (r.json().get("data") or [{}])[0].get("b64_json")
            return base64.b64decode(b64) if b64 else None
        except Exception:
            return None


async def _upload_cover(image: bytes, *, user_id: str, title: str, settings) -> str | None:
    """Persist the cover to Supabase Storage (cover-images bucket); return its public URL."""
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return None
    from datetime import datetime

    ts = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    path = f"{user_id or 'anon'}/{ts}_{_slug(title)}.png"
    base = settings.supabase_url.rstrip("/")
    key = settings.supabase_service_role_key
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            r = await client.post(
                f"{base}/storage/v1/object/cover-images/{path}",
                headers={"apikey": key, "Authorization": f"Bearer {key}",
                         "Content-Type": "image/png", "x-upsert": "true"},
                content=image,
            )
            r.raise_for_status()
            return f"{base}/storage/v1/object/public/cover-images/{path}"
        except Exception:
            return None


async def _op_cover_art(payload: dict) -> dict:
    """Generate a book cover: KIE.AI (nano-banana) -> DALL-E 3 fallback -> persist to Supabase."""
    settings = get_settings()
    prompt = _cover_prompt(payload)
    user_id = str(payload.get("user_id") or "anon")
    title = str(payload.get("title") or "Untitled")

    image: bytes | None = None
    provider = "none"
    if settings.kieai_api_key:
        image = await _kieai_cover(prompt, key=settings.kieai_api_key)
        provider = "kieai" if image else provider
    if image is None and settings.openai_api_key:
        image = await _dalle_cover(prompt, key=settings.openai_api_key)
        provider = "dalle" if image else provider
    if image is None:
        return {"image_url": f"https://placehold.co/1600x2400?text={_slug(title)}",
                "provider": "stub", "prompt": prompt}

    public_url = await _upload_cover(image, user_id=user_id, title=title, settings=settings)
    return {"image_url": public_url or "(generated, not persisted — storage unconfigured)",
            "provider": provider, "persisted": bool(public_url), "prompt": prompt}


def _social_system() -> str:
    """Craft-composed voice for social copy — transparent prose + snappy, no-fluff lines."""
    return compose_craft_system(
        seed_keys=["follett_seeds.prose.transparent", "follett_seeds.prose.dialogue"]
    ) + (
        "\n\nWrite ONE social post per requested platform promoting the work. Match each platform's "
        "norms (length, tone). Transparent, concrete, hook-first. Return strict JSON: an object "
        "mapping each platform name to its post string."
    )


async def _op_social_posts(payload: dict) -> dict:
    platforms = list(payload.get("platforms") or ["twitter", "linkedin"])
    summary = str(payload.get("summary") or payload.get("title") or "")
    router = get_router(service=STEP_NAME)
    try:
        resp = await router.complete(
            provider="anthropic",
            model=get_settings().model_cheap,
            system=_social_system(),
            prompt=f"WORK:\n{summary}\n\nPLATFORMS: {', '.join(platforms)}\nReturn JSON only.",
            max_tokens=1200,
        )
        data = json.loads(extract_json(resp.text))
        return {p: str(data.get(p, "")) for p in platforms}
    except (ProviderNotRegistered, json.JSONDecodeError, ValueError):
        return {p: f"(fixture) social post for {p}: {summary[:60]}" for p in platforms}


async def _op_scrape_url(payload: dict) -> dict:
    """Firecrawl scrape -> markdown + html + metadata. Fixture when no key/url."""
    settings = get_settings()
    url = payload.get("url")
    if not url:
        return {"url": None, "markdown": "", "html": "", "metadata": {}, "note": "no url"}
    if not settings.firecrawl_api_key:
        return {"url": url, "markdown": "(stub — FIRECRAWL_API_KEY not set)", "html": "", "metadata": {}}
    body = {"url": url, "formats": ["markdown", "html"]}
    async with httpx.AsyncClient(timeout=90.0) as client:
        try:
            r = await client.post(
                "https://api.firecrawl.dev/v1/scrape",
                headers={"Authorization": f"Bearer {settings.firecrawl_api_key}",
                         "Content-Type": "application/json"},
                json=body,
            )
            r.raise_for_status()
            data = r.json().get("data") or {}
            return {"url": url, "markdown": data.get("markdown") or "", "html": data.get("html") or "",
                    "metadata": data.get("metadata") or {}}
        except Exception as e:
            return {"url": url, "markdown": "", "html": "", "metadata": {}, "error": str(e)[:200]}


OPS = {"cover-art": _op_cover_art, "social-posts": _op_social_posts, "scrape-url": _op_scrape_url}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "cover-art")
    if op not in OPS:
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={"code": "UNKNOWN_OP", "message": op},  # type: ignore[arg-type]
        )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": await OPS[op](inp.payload)},
    )


app = build_step_app(STEP_NAME, handler)
