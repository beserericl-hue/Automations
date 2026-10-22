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
from writer_engine.fixtures import guard_fixture_fallback
from writer_engine.llm import ProviderNotRegistered, get_router
from writer_engine.llm.structured import extract_json
from writer_engine.prompt_store import compose_craft_system, seed_default_prompts
from writer_engine.rate_limit.provider_budget import call_provider
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "media"
logger = get_logger(STEP_NAME)
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
        f'Professional book cover illustration for the novel "{title}"',
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

        async def _create() -> httpx.Response:
            r = await client.post(_KIEAI_CREATE, headers=headers, json=body)
            r.raise_for_status()
            return r

        try:
            # B8: only the createTask call is budgeted. The recordInfo polls below hit the same API
            # but gating them would stall the poll loop against its own 180s deadline, so they are
            # left ungated (they are cheap, and one generation is already accounted for here).
            r = await call_provider("kieai", _create, model="google/nano-banana")
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
    body = {
        "model": "dall-e-3",
        "prompt": prompt[:3900],
        "size": "1024x1792",
        "n": 1,
        "response_format": "b64_json",
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            r = await client.post(_OPENAI_IMAGES, headers=headers, json=body)
            r.raise_for_status()
            b64 = (r.json().get("data") or [{}])[0].get("b64_json")
            return base64.b64decode(b64) if b64 else None
        except Exception:
            return None


async def _upload_cover(image: bytes, *, user_id: str, title: str, settings) -> tuple[str | None, str | None]:
    """Persist the cover to Supabase Storage (cover-images bucket).

    Returns ``(public_url, storage_path)`` — the storage_path (relative to the bucket) is what the
    ``generated_images_v2`` row stores, matching the n8n save_to_storage convention.
    """
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return None, None
    from datetime import datetime

    ts = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    path = f"{user_id or 'anon'}/{ts}_{_slug(title)}.png"
    base = settings.supabase_url.rstrip("/")
    key = settings.supabase_service_role_key
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            r = await client.post(
                f"{base}/storage/v1/object/cover-images/{path}",
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "image/png",
                    "x-upsert": "true",
                },
                content=image,
            )
            r.raise_for_status()
            return f"{base}/storage/v1/object/public/cover-images/{path}", path
        except Exception:
            return None, None


async def _record_generated_image(
    *,
    storage_path: str,
    user_id: str,
    project_id: str | None,
    prompt: str,
    genre_slug: str | None,
    provider: str,
    title: str,
    settings,
) -> bool:
    """Insert a generated_images_v2 row so the cover shows in the UI gallery / as the project cover.

    Mirrors the n8n save_to_storage node (workflow 02). Best-effort: a DB failure must not fail the
    generation itself (the image is already in Storage), so this returns a bool and never raises.
    """
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return False
    base = settings.supabase_url.rstrip("/")
    key = settings.supabase_service_role_key
    body = {
        "user_id": user_id or "anon",
        "project_id": project_id or None,
        "image_type": "cover_art",
        "storage_path": storage_path,
        "original_prompt": prompt[:10000],
        "genre_slug": genre_slug or None,
        "image_format": "png",
        "generation_model": "nano-banana-pro" if provider == "kieai" else (provider or "unknown"),
        "metadata": {"story_title": title, "content_type": "cover_art", "provider": provider},
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.post(
                f"{base}/rest/v1/generated_images_v2",
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                json=body,
            )
            r.raise_for_status()
            return True
        except Exception:
            return False


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
        # A1: no image provider produced anything — almost always KIEAI_API_KEY/OPENAI_API_KEY
        # missing. A placehold.co URL previously got persisted and emailed as the user's cover art.
        guard_fixture_fallback(
            step=STEP_NAME,
            reason="no image provider available (KIEAI_API_KEY / OPENAI_API_KEY unset or both failed)",
        )
        return {
            "image_url": f"https://placehold.co/1600x2400?text={_slug(title)}",
            "provider": "stub",
            "prompt": prompt,
        }

    public_url, storage_path = await _upload_cover(image, user_id=user_id, title=title, settings=settings)
    recorded = False
    if storage_path:
        recorded = await _record_generated_image(
            storage_path=storage_path,
            user_id=user_id,
            project_id=(str(payload["project_id"]) if payload.get("project_id") else None),
            prompt=prompt,
            genre_slug=(payload.get("genre_slug") or payload.get("genre")),
            provider=provider,
            title=title,
            settings=settings,
        )
    return {
        "image_url": public_url or "(generated, not persisted — storage unconfigured)",
        "storage_path": storage_path,
        "provider": provider,
        "persisted": bool(public_url),
        "db_recorded": recorded,
        "prompt": prompt,
    }


# Published limits, so a humanized post that cannot be posted is never kept. Generous where the
# platform is generous — the cap exists to catch a runaway rewrite, not to re-impose house style.
_PLATFORM_LIMITS = {
    "twitter": 280,
    "x": 280,
    "bluesky": 300,
    "mastodon": 500,
    "threads": 500,
    "instagram": 2200,
    "linkedin": 3000,
    "facebook": 5000,
}


def _social_system() -> str:
    """Craft-composed voice for social copy — transparent prose + snappy, no-fluff lines."""
    return compose_craft_system(
        seed_keys=["follett_seeds.prose.transparent", "follett_seeds.prose.dialogue"]
    ) + (
        "\n\nWrite ONE social post per requested platform promoting the work. Transparent, "
        "concrete, hook-first. Return strict JSON: an object mapping each platform name to its "
        "post string.\n\n"
        "LENGTH IS A HARD LIMIT, NOT A STYLE NOTE. A post over its platform's limit cannot be "
        "posted at all. Count the characters and stay under:\n"
        + "\n".join(f"- {name}: {limit} characters" for name, limit in sorted(_PLATFORM_LIMITS.items()))
        + "\nFor the short ones, aim ten percent under — a hashtag or a link added later still has "
        "to fit."
    )


_VALID_SOCIAL = {"twitter", "linkedin", "instagram", "facebook"}


async def _persist_social_posts(payload: dict, posts: dict) -> dict | None:
    """Persist generated social posts to social_posts_v2 so they show in the project Social tab (and the
    /social library). Resolves project_id from a supplied project_title (chat/voice pass a title, not a
    UUID). Only the four DB-valid platforms are stored. Best-effort — never breaks generation."""
    settings = get_settings()
    user_id = payload.get("user_id")
    if not (user_id and settings.supabase_url and settings.supabase_service_role_key):
        return {"persisted": False, "reason": "no user_id / supabase"}
    try:
        from writer_engine.persist_helpers import resolve_project_id
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        project_id = payload.get("project_id")
        if not project_id and payload.get("project_title"):
            project_id, _row = await resolve_project_id(
                client, user_id=str(user_id), title=str(payload["project_title"])
            )
        rows = [
            {
                "user_id": str(user_id),
                "project_id": project_id,
                "platform": p,
                "post_text": t.strip(),
                "status": "draft",
            }
            for p, t in posts.items()
            if p in _VALID_SOCIAL and str(t).strip() and not str(t).lstrip().startswith("(fixture)")
        ]
        if not rows:
            return {"persisted": False, "reason": "no valid-platform posts to save"}
        await client.table("social_posts_v2").insert(rows).execute()
        return {"persisted": True, "count": len(rows), "project_id": project_id}
    except Exception as exc:
        # Persisting social posts is best-effort: the generated posts are already returned to the
        # caller, so a DB failure must not fail the op. Reported, not raised.
        return {"persisted": False, "error": str(exc)[:200]}


def _over_limit(posts: dict[str, str]) -> dict[str, dict[str, int]]:
    """Which posts cannot be posted, and by how much.

    A platform limit is the one piece of social-media guidance that is not a matter of taste: at
    281 characters X simply refuses the post. So it is measured rather than requested.
    """
    out: dict[str, dict[str, int]] = {}
    for platform, text in posts.items():
        limit = _PLATFORM_LIMITS.get(platform.lower())
        if limit and len(text) > limit:
            out[platform] = {"chars": len(text), "limit": limit}
    return out


async def _shorten_to_fit(
    posts: dict[str, str], offenders: dict[str, dict[str, int]], summary: str
) -> dict[str, str]:
    """One corrective pass over the posts that are too long, naming the count and the target.

    Only the offenders are rewritten; a post that already fits is left exactly as it was, because
    regenerating the set to fix one of them loses the others.
    """
    router = get_router(service=STEP_NAME)
    fixed = dict(posts)
    for platform, info in offenders.items():
        try:
            resp = await router.complete(
                provider="anthropic",
                model=get_settings().model_cheap,
                system=(
                    "You shorten social posts. Keep the hook, the concrete nouns and the voice. "
                    "Cut qualifiers and subordinate clauses first. Return ONLY the shortened post, "
                    "with no quotation marks around it and no commentary."
                ),
                prompt=(
                    f"This {platform} post is {info['chars']} characters and the limit is "
                    f"{info['limit']}. Rewrite it to at most {int(info['limit'] * 0.95)} "
                    f"characters.\n\nPOST:\n{posts[platform]}"
                ),
                max_tokens=600,
            )
            candidate = resp.text.strip().strip('"')
            # Only taken if it actually helped. A "shortened" version that is still over, or that
            # has been cut to nothing, is worse than the original.
            if 40 <= len(candidate) <= info["limit"]:
                fixed[platform] = candidate
        except (ProviderNotRegistered, ValueError):
            continue
    return fixed


async def _humanize_posts(posts: dict[str, str], payload: dict) -> tuple[dict[str, str], dict | None]:
    """Humanize each social post, keeping the original where the rewrite would not be publishable."""
    from writer_engine.humanize import extract_protected_terms, humanize_draft

    out: dict[str, str] = {}
    report: dict = {"platforms": {}}
    ran = False
    for platform, text in posts.items():
        original = str(text or "")
        if not original.strip():
            out[platform] = original
            continue
        rewritten, one = await humanize_draft(
            original,
            content_type=f"social:{platform}",
            payload=payload,
            protect=extract_protected_terms(original),
        )
        if one is None:
            out[platform] = original
            continue
        ran = True
        limit = _PLATFORM_LIMITS.get(platform.lower())
        if limit and len(rewritten) > limit:
            logger.warning(
                "humanize.social.too_long",
                platform=platform,
                chars=len(rewritten),
                limit=limit,
            )
            one["rejected_for_length"] = {"chars": len(rewritten), "limit": limit}
            out[platform] = original
        else:
            out[platform] = rewritten
        report["platforms"][platform] = one
    return out, (report if ran else None)


async def _op_social_posts(payload: dict) -> dict:
    platforms = list(payload.get("platforms") or ["twitter", "linkedin"])
    summary = str(payload.get("summary") or payload.get("title") or "").strip()
    posts: dict[str, str] = {}
    # An empty WORK yields garbage — don't even call the model; treat as "no content".
    if len(summary) >= 3:
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
            posts = {p: str(data.get(p, "")).strip() for p in platforms}
        except (ProviderNotRegistered, json.JSONDecodeError, ValueError):
            posts = {}
    # A real post needs real content. If we have none, DON'T persist a placeholder or report success —
    # the old code saved a "(fixture) social post…" row (with project_id NULL) and the chat told the user
    # it was "finished, in the content library." Surface an actionable error instead.
    if not any(posts.values()):
        return {
            "error": "insufficient_context",
            "message": (
                "I couldn't generate a social post — tell me which project and what the post is about, e.g. "
                '"Write a LinkedIn post for The Last Signal introducing our newsletter."'
            ),
        }
    # E6: humanize each post individually, with a hard character cap per platform.
    #
    # Two reasons this is not just a call to humanize_draft on the joined text. A platform limit is
    # a publish blocker, not a style preference: a rewrite that pushes a tweet past 280 characters
    # cannot be posted at all, so it is rejected and the original kept. And a post is SHORT, which
    # is the exact condition under which this model behaved worst in testing — on a 29-word passage
    # it replaced a character's name with a pronoun, where at 1431 words it kept every name. So the
    # per-post protect list is extracted from the post itself and the result is length-checked.
    # CHECKED, NOT ASKED. The prompt states every limit, and a prompt is not a guarantee: a post
    # measured at 309 characters against X's 280 went out of here publishable-looking and
    # unpublishable. One corrective pass over the offenders, before humanizing, so the humanizer's
    # own length guard has something in-limit to protect.
    offenders = _over_limit(posts)
    if offenders:
        logger.info("social.over_limit_retry", offenders=offenders)
        posts = await _shorten_to_fit(posts, offenders, summary)

    posts, humanize_report = await _humanize_posts(posts, payload)

    # Measured again at the end: the humanizer keeps the original when its rewrite would not fit,
    # so a post that was over before is still over now.
    still_over = _over_limit(posts)
    if still_over:
        logger.warning("social.over_limit_kept", offenders=still_over)

    persisted = await _persist_social_posts(payload, posts)
    out = {**posts, "humanize": humanize_report, "persist": persisted}
    if still_over:
        out["over_limit"] = still_over
    return out


async def _op_scrape_url(payload: dict) -> dict:
    """Firecrawl scrape -> markdown + html + metadata. Fixture when no key/url."""
    settings = get_settings()
    url = payload.get("url")
    if not url:
        return {"url": None, "markdown": "", "html": "", "metadata": {}, "note": "no url"}
    if not settings.firecrawl_api_key:
        # A1: scraped text feeds newsletter segments and blog grounding. A "(stub — …)" body silently
        # became the source material for generated copy.
        guard_fixture_fallback(step=STEP_NAME, reason="FIRECRAWL_API_KEY not set")
        return {"url": url, "markdown": "(stub — FIRECRAWL_API_KEY not set)", "html": "", "metadata": {}}
    body = {"url": url, "formats": ["markdown", "html"]}
    async with httpx.AsyncClient(timeout=90.0) as client:

        async def _post() -> httpx.Response:
            r = await client.post(
                "https://api.firecrawl.dev/v1/scrape",
                headers={
                    "Authorization": f"Bearer {settings.firecrawl_api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
            r.raise_for_status()
            return r

        try:
            r = await call_provider("firecrawl", _post)  # B8: budget + 429 retry
            data = r.json().get("data") or {}
            return {
                "url": url,
                "markdown": data.get("markdown") or "",
                "html": data.get("html") or "",
                "metadata": data.get("metadata") or {},
            }
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
    result = await OPS[op](inp.payload)
    # An op that couldn't produce a real deliverable returns {"error": …}; surface it as a step ERROR so
    # the hub/UI reports "couldn't generate" instead of "finished" for a post that was never created.
    if isinstance(result, dict) and result.get("error"):
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={
                "code": str(result.get("error")),  # type: ignore[arg-type]
                "message": str(result.get("message") or result.get("error")),
            },
        )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": result},
    )


app = build_step_app(STEP_NAME, handler)
