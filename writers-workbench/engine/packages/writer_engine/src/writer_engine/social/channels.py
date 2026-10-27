"""What one post looks like on each channel, and the calls that send it.

Ported from the n8n subs ``Sub - Post Blog to Website (API)`` (427jMgRQEYzDA1IN), ``Sub - Publish to
LinkedIn (Blotato)`` (rkwZa88G7EJc7HY8) and the image half of ``Sub - Publish Blog All Channels v2``
(6eQyuNp2A2bEIx1a). The request builders are pure, so the exact payloads are under test; the senders
are thin and take an ``httpx.AsyncClient`` so tests can hand them a mock transport.

Differences from n8n, all deliberate:

* Channels, endpoints and LinkedIn page ids come from ``social_channels_v2``, not from code, and
  the API keys come from Railway variables named in the channel config. n8n typed the KIE key into
  six nodes.
* The personal LinkedIn profile is its own channel (``li_personal``). n8n posted there silently
  whenever any company page was chosen, so "both pages" was three posts nobody could see coming.
* The website's public URL is built from ``public_base`` + slug. The TechAhir API answers with a
  ``localhost:3000`` URL, which n8n stored as the post's link.
* Blotato's error detail is kept. n8n read only ``status`` and lost the reason (e.g. code 5002,
  "Account connection has expired").
"""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from writer_engine.telemetry.logging import get_logger

logger = get_logger("social.channels")

CHANNELS_TABLE = "social_channels_v2"

LINKEDIN_MAX_CHARS = 2990
"""Blotato rejects LinkedIn text past 3,000 characters; n8n trimmed to 2,990."""

KIE_CREATE = "https://api.kie.ai/api/v1/playground/createTask"
KIE_RECORD = "https://api.kie.ai/api/v1/playground/recordInfo"
KIE_TIMEOUT_S = 180
"""n8n's Publish All v2 gave up on the image after 180s and posted without it. Same here."""

OK_DELIVERY = frozenset({"published", "submitted", "dry_run"})
BLOTATO_PENDING = frozenset({"in-progress", "pending", "queued", "processing", "scheduled"})


@dataclass(frozen=True)
class Channel:
    user_id: str
    channel: str
    kind: str  # 'website' | 'linkedin'
    label: str
    config: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Channel:
        return cls(
            user_id=str(row.get("user_id") or ""),
            channel=str(row.get("channel") or ""),
            kind=str(row.get("kind") or ""),
            label=str(row.get("label") or row.get("channel") or ""),
            config=dict(row.get("config") or {}),
            enabled=bool(row.get("enabled", True)),
        )


async def load_channels(client: Any, user_id: str) -> dict[str, Channel]:
    resp = await client.table(CHANNELS_TABLE).select("*").eq("user_id", user_id).execute()
    return {c.channel: c for c in (Channel.from_row(r) for r in (resp.data or []))}


# ---------------------------------------------------------------------------
# Text helpers (ports of the n8n Prep / Normalize Inputs code)
# ---------------------------------------------------------------------------

_LINKEDIN_SECTION = re.compile(r"##?\s*linkedin", re.IGNORECASE)
_MD_LINK = re.compile(r"\[[^\]]*\]\([^)]*\)")
_URL = re.compile(r"https?://\S+")


def blog_body(body_md: str) -> str:
    """The blog markdown without the LinkedIn draft the writers append after a ``## LinkedIn`` heading."""
    return _LINKEDIN_SECTION.split(body_md or "", maxsplit=1)[0].strip()


def excerpt_for(body_md: str, meta_description: str = "") -> str:
    if meta_description.strip():
        return meta_description.strip()[:300]
    clean = _MD_LINK.sub("", body_md or "")
    clean = re.sub(r"[#*>`_~\[\]()-]+", " ", clean)
    return re.sub(r"\s+", " ", clean).strip()[:180]


def image_concept(text: str) -> str:
    concept = _MD_LINK.sub(" ", blog_body(text))
    concept = _URL.sub(" ", concept)
    concept = re.sub(r"[#>*`_~\[\]()]+", " ", concept)
    return re.sub(r"\s+", " ", concept).strip()[:700]


def sketchnote_prompt(title: str, body_md: str) -> str:
    """The n8n sketchnote prompt, verbatim apart from the inputs."""
    return (
        "A hand-drawn black-ink SKETCHNOTE infographic on a cream / off-white paper background, friendly "
        "whiteboard-doodle explainer style. Illustrate the key idea or process of this article: "
        f'"{title}". Details: {image_concept(body_md)}. Simple hand-drawn doodle icons connected by curved '
        "arrows; if the article describes steps draw a numbered left-to-right flow, otherwise a single "
        "conceptual doodle. Black marker line art, light pencil shading, clean negative space. Only a few "
        "very short hand-lettered labels (about 3 words max). No photorealism, no futuristic 3D. Friendly "
        "explainer sketch."
    )


def fit_linkedin(content: str, *, cta_marker: str = "www.techahir.com") -> str:
    """Trim a post to LinkedIn's limit, keeping the call-to-action tail intact (n8n's rule)."""
    content = (content or "").strip()
    if len(content) <= LINKEDIN_MAX_CHARS:
        return content
    lines = content.split("\n")
    cta_idx = next((i for i, line in enumerate(lines) if cta_marker in line.lower()), -1)
    cta = "\n".join(lines[cta_idx:]).strip() if cta_idx >= 0 else ""
    if len(cta) > 400:
        cta = ""
    room = LINKEDIN_MAX_CHARS - (len(cta) + 2 if cta else 0)
    body = ("\n".join(lines[:cta_idx]) if cta_idx >= 0 else content).strip()
    if len(body) > room:
        body = body[: room - 1].strip() + "…"
    return f"{body}\n\n{cta}" if cta else body


# ---------------------------------------------------------------------------
# Request builders
# ---------------------------------------------------------------------------


def website_request(
    row: dict[str, Any], channel: Channel, *, cover: tuple[bytes, str] | None, now: datetime
) -> dict[str, Any]:
    body_md = blog_body(str(row.get("body_md") or ""))
    title = str(row.get("title") or "Untitled").strip()
    payload: dict[str, Any] = {
        "externalId": str(row.get("external_id") or ""),
        "title": title,
        "bodyMarkdown": body_md,
        "excerpt": excerpt_for(body_md, str(row.get("meta_description") or "")),
        "seoTitle": (str(row.get("seo_title") or "") or title)[:120],
        "metaDescription": str(row.get("meta_description") or "")[:300],
        "category": (str(row.get("category") or "") or "INSIGHTS").upper()[:60],
        "author": str(channel.config.get("author") or "Tech Ahir"),
        "status": "draft" if str(row.get("post_status") or "") == "draft" else "published",
        "publishedAt": now.astimezone(UTC).isoformat().replace("+00:00", "Z"),
    }
    if cover is not None:
        data, content_type = cover
        payload["coverImage"] = {"data": base64.b64encode(data).decode("ascii"), "contentType": content_type}
    return payload


def linkedin_request(row: dict[str, Any], channel: Channel, *, media_url: str | None) -> dict[str, Any]:
    text = str(row.get("linkedin_content") or "") or blog_body(str(row.get("body_md") or ""))
    target: dict[str, Any] = {"targetType": "linkedin"}
    page_id = str(channel.config.get("page_id") or "").strip()
    if page_id:
        target["pageId"] = page_id
    return {
        "post": {
            "accountId": str(channel.config.get("account_id") or ""),
            "content": {
                "text": fit_linkedin(text),
                "platform": "linkedin",
                "mediaUrls": [media_url] if media_url else [],
            },
            "target": target,
        }
    }


def redact_request(request: dict[str, Any]) -> dict[str, Any]:
    """What we store of a request: the cover image's bytes become their size."""
    out = json.loads(json.dumps(request))
    cover = out.get("coverImage")
    if isinstance(cover, dict) and isinstance(cover.get("data"), str):
        cover["data"] = f"<base64, {len(cover['data'])} chars>"
    return out


# ---------------------------------------------------------------------------
# Senders
# ---------------------------------------------------------------------------


@dataclass
class SendResult:
    status: str  # 'published' | 'submitted' | 'failed'
    public_url: str | None = None
    provider_ref: str | None = None
    detail: str = ""
    response: dict[str, Any] | None = None


def _secret(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def website_public_url(channel: Channel, response: dict[str, Any]) -> str | None:
    slug = str(response.get("slug") or "").strip().strip("/")
    base = str(channel.config.get("public_base") or "").strip()
    if slug and base:
        return base.rstrip("/") + "/" + slug
    url = str(response.get("url") or "").strip()
    if url and "localhost" not in url and "127.0.0.1" not in url:
        return url
    if url and base:
        return base.rstrip("/") + "/" + url.rstrip("/").rsplit("/", 1)[-1]
    return None


async def send_website(http: httpx.AsyncClient, channel: Channel, request: dict[str, Any]) -> SendResult:
    endpoint = str(channel.config.get("endpoint") or "").strip()
    header = str(channel.config.get("auth_header") or "Authorization").strip()
    env_name = str(channel.config.get("auth_env") or "").strip()
    token = _secret(env_name) if env_name else ""
    if not endpoint:
        return SendResult("failed", detail=f"channel {channel.channel}: no endpoint configured")
    if not token:
        return SendResult("failed", detail=f"channel {channel.channel}: {env_name or 'auth_env'} is not set")
    value = (
        token
        if header.lower() != "authorization" or token.lower().startswith("bearer ")
        else f"Bearer {token}"
    )
    resp = await http.post(endpoint, json=request, headers={header: value}, timeout=60.0)
    data = _json(resp)
    if resp.status_code >= 400:
        return SendResult("failed", detail=f"HTTP {resp.status_code}: {_short(data)}", response=data)
    url = website_public_url(channel, data)
    dup = " (already existed)" if data.get("duplicate") else ""
    return SendResult("published", public_url=url, detail=f"posted to {channel.label}{dup}", response=data)


def _blotato_headers(api_key: str) -> dict[str, str]:
    return {"blotato-api-key": api_key, "Content-Type": "application/json"}


async def send_linkedin(
    http: httpx.AsyncClient, channel: Channel, request: dict[str, Any], *, api_key: str, base_url: str
) -> SendResult:
    if not api_key:
        return SendResult("failed", detail="BLOTATO_API_KEY is not set")
    if not request["post"]["accountId"]:
        return SendResult("failed", detail=f"channel {channel.channel}: no Blotato account_id configured")
    resp = await http.post(f"{base_url}/posts", json=request, headers=_blotato_headers(api_key), timeout=60.0)
    data = _json(resp)
    if resp.status_code >= 400:
        return SendResult("failed", detail=f"Blotato HTTP {resp.status_code}: {_short(data)}", response=data)
    ref = str(data.get("postSubmissionId") or "")
    if not ref:
        return SendResult(
            "failed", detail=f"Blotato returned no postSubmissionId: {_short(data)}", response=data
        )
    return SendResult("submitted", provider_ref=ref, detail=f"submitted to {channel.label}", response=data)


async def blotato_status(http: httpx.AsyncClient, ref: str, *, api_key: str, base_url: str) -> SendResult:
    """What Blotato says now about a submitted post. ``submitted`` while it is still working."""
    resp = await http.get(f"{base_url}/posts/{ref}", headers=_blotato_headers(api_key), timeout=20.0)
    data = _json(resp)
    if resp.status_code >= 400:
        return SendResult(
            "submitted", provider_ref=ref, detail=f"status check HTTP {resp.status_code}", response=data
        )
    status = str(data.get("status") or "").lower()
    if status == "published":
        return SendResult(
            "published", public_url=data.get("publicUrl") or None, provider_ref=ref, response=data
        )
    if status in BLOTATO_PENDING or not status:
        return SendResult(
            "submitted", provider_ref=ref, detail=f"Blotato status: {status or 'unknown'}", response=data
        )
    # 'failed' and anything else unknown: keep every field Blotato gave, the reason is in there.
    reason = data.get("errorMessage") or data.get("error") or data.get("message") or _short(data)
    return SendResult("failed", provider_ref=ref, detail=f"Blotato {status}: {reason}"[:500], response=data)


async def blotato_upload_media(
    http: httpx.AsyncClient, url: str, *, api_key: str, base_url: str
) -> str | None:
    resp = await http.post(
        f"{base_url}/media", json={"url": url}, headers=_blotato_headers(api_key), timeout=60.0
    )
    if resp.status_code >= 400:
        logger.warning("social.blotato_media_failed", status=resp.status_code, body=_short(_json(resp)))
        return None
    return str(_json(resp).get("url") or "") or None


async def kie_sketchnote(
    http: httpx.AsyncClient, prompt: str, *, api_key: str, sleep: Any
) -> tuple[bytes, str, str] | None:
    """(bytes, content type, source url) of a nano-banana image, or None. Never raises."""
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    body = {"model": "google/nano-banana", "callBackUrl": "", "input": {"prompt": prompt, "image_urls": []}}
    try:
        r = await http.post(KIE_CREATE, json=body, headers=headers, timeout=60.0)
        task_id = ((_json(r).get("data") or {}).get("taskId")) if r.status_code < 400 else None
        if not task_id:
            return None
        waited = 0
        while waited < KIE_TIMEOUT_S:
            await sleep(6)
            waited += 6
            pr = await http.get(KIE_RECORD, params={"taskId": task_id}, headers=headers, timeout=30.0)
            data = _json(pr).get("data") or {}
            state = str(data.get("state") or "")
            if state == "success":
                urls = json.loads(data.get("resultJson") or "{}").get("resultUrls") or []
                if not urls:
                    return None
                img = await http.get(urls[0], timeout=60.0)
                if img.status_code >= 400:
                    return None
                return img.content, img.headers.get("content-type", "image/png").split(";")[0], urls[0]
            if state in ("fail", "error", "failed"):
                return None
        return None
    except Exception as exc:  # an image is decoration; the post goes out without it
        logger.warning("social.image_failed", error=f"{type(exc).__name__}: {exc}"[:200])
        return None


def _json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        return {"raw": resp.text[:500]}
    return data if isinstance(data, dict) else {"data": data}


def _short(data: dict[str, Any]) -> str:
    return json.dumps(data)[:300]
