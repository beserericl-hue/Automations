"""What one post looks like on each channel, and the calls that send it.

Ported from the n8n subs ``Sub - Post Blog to Website (API)`` (427jMgRQEYzDA1IN), ``Sub - Publish to
LinkedIn (Blotato)`` (rkwZa88G7EJc7HY8) and the image half of ``Sub - Publish Blog All Channels v2``
(6eQyuNp2A2bEIx1a). The request builders are pure, so the exact payloads are under test; the senders
are thin and take an ``httpx.AsyncClient`` so tests can hand them a mock transport.

Differences from n8n, all deliberate:

* Channels, endpoints and LinkedIn page ids come from ``social_channels_v2``, not from code, and
  the Blotato key, Blotato account and each blog's token are the *user's* own, stored encrypted in
  ``user_integrations_v2`` (Settings → Integrations; see ``writer_engine.integrations``). There is
  no company key in a Railway variable. n8n typed the KIE key into six nodes.
* Blotato posts to every platform on the user's key, not only LinkedIn (migration 055): a channel's
  ``kind`` is the platform and its config carries the account (and page / board). The social text
  is cut to each platform's limit with its link kept; platforms that need an image say so instead
  of failing at Blotato.
* A blog endpoint is user-supplied, so it is checked for SSRF (https, public addresses only) at
  send time as well as when it is saved.
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
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from writer_engine.safe_http import UnsafeDestinationError
from writer_engine.telemetry.logging import get_logger
from writer_engine.url_safety import Resolver, check_public_https_url

logger = get_logger("social.channels")

CHANNELS_TABLE = "social_channels_v2"

LINKEDIN_MAX_CHARS = 2990
"""Blotato rejects LinkedIn text past 3,000 characters; n8n trimmed to 2,990."""

TEXT_LIMITS: dict[str, int] = {
    "linkedin": LINKEDIN_MAX_CHARS,
    "facebook": 5000,
    "instagram": 2200,
    "threads": 500,
    "twitter": 280,
    "bluesky": 300,
    "pinterest": 500,
    "tiktok": 2200,
    "youtube": 5000,
}
"""Each platform's text limit (migration 055). The social text is written once, LinkedIn-length;
the shorter platforms get it cut at a sentence end with the link kept (``fit_text``)."""

NEEDS_IMAGE = frozenset({"instagram", "pinterest", "tiktok"})
"""Platforms Blotato will not post text alone to: the post must carry an image."""
VIDEO_ONLY = frozenset({"youtube"})
"""Platforms the calendar cannot post to at all: they take a video, and a post has none."""

PLATFORM_LABEL: dict[str, str] = {
    "linkedin": "LinkedIn",
    "facebook": "Facebook",
    "instagram": "Instagram",
    "threads": "Threads",
    "twitter": "X",
    "bluesky": "Bluesky",
    "pinterest": "Pinterest",
    "tiktok": "TikTok",
    "youtube": "YouTube",
}


def is_blotato(kind: str) -> bool:
    """A channel Blotato posts to, i.e. anything that is not the website."""
    return kind in TEXT_LIMITS


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
    kind: str  # 'website', or a Blotato platform: 'linkedin' | 'facebook' | 'threads' | ... (055)
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
    return fit_text(content, LINKEDIN_MAX_CHARS, cta_marker=cta_marker)


_CLOSING_QUOTES = "\"'" + chr(0x201D) + chr(0x2019) + ")"  # closing quotes may follow the full stop
_SENTENCE_END = re.compile(r"[.!?…][" + _CLOSING_QUOTES + r"]*(?=\s)")


def fit_text(content: str, limit: int, *, cta_marker: str = "www.techahir.com") -> str:
    """Cut a post to ``limit`` characters, keeping its link.

    The tail is the call-to-action line (the line naming ``cta_marker``), or failing that the last
    line with a URL in it. On a platform too short for the whole tail (X, Bluesky) only the URL is
    kept. The body is cut at the last sentence end that fits, so an X post ends on a full stop and
    the link, not mid-word; a single sentence longer than the room is cut with an ellipsis.
    """
    content = (content or "").strip()
    if len(content) <= limit:
        return content
    lines = content.split("\n")
    cta_idx = next((i for i, line in enumerate(lines) if cta_marker in line.lower()), -1)
    if cta_idx < 0:
        cta_idx = next((i for i in range(len(lines) - 1, -1, -1) if _URL.search(lines[i])), -1)
    cta = "\n".join(lines[cta_idx:]).strip() if cta_idx >= 0 else ""
    if len(cta) > min(400, limit // 2):
        url = _URL.search(cta)
        cta = url.group(0) if url and len(url.group(0)) <= limit // 2 else ""
    room = limit - (len(cta) + 2 if cta else 0)
    body = ("\n".join(lines[:cta_idx]) if cta_idx >= 0 else content).strip()
    if len(body) > room:
        cut = body[:room]
        ends = [m.end() for m in _SENTENCE_END.finditer(cut + " ")]
        last = max((e for e in ends if e <= room), default=0)
        body = cut[:last].strip() if last >= room // 3 else cut[: room - 1].strip() + "…"
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


def linkedin_request(
    row: dict[str, Any], channel: Channel, *, media_url: str | None, account_id: str = ""
) -> dict[str, Any]:
    """A LinkedIn post through Blotato (kept for the callers that predate 055)."""
    return blotato_request(row, channel, media_url=media_url, account_id=account_id)


def blotato_target(channel: Channel, row: dict[str, Any], *, has_media: bool) -> dict[str, Any]:
    """``post.target`` for the channel's platform, with what Blotato requires of each one."""
    platform = channel.kind
    cfg = channel.config
    target: dict[str, Any] = {"targetType": platform}
    page_id = str(cfg.get("page_id") or "").strip()
    link = str(row.get("source_url") or "").strip()
    if platform == "linkedin" and page_id:
        target["pageId"] = page_id
    elif platform == "facebook":
        target["pageId"] = page_id
        if link and not has_media:
            target["link"] = link
    elif platform == "pinterest":
        target["boardId"] = str(cfg.get("board_id") or "").strip()
        title = str(row.get("title") or "").strip()[:100]
        if title:
            target["title"] = title
        if link:
            target["link"] = link[:2048]
    elif platform == "tiktok":
        target.update(
            {
                "privacyLevel": "PUBLIC_TO_EVERYONE",
                "disabledComments": False,
                "disabledDuet": False,
                "disabledStitch": False,
                "isBrandedContent": False,
                "isYourBrand": False,
                # The sketchnote is generated; an image the owner chose is theirs to declare.
                "isAiGenerated": bool(row.get("include_image")) and not str(row.get("image_url") or ""),
            }
        )
    elif platform == "youtube":
        target.update(
            {
                "title": str(row.get("title") or "Untitled").strip()[:100].replace("<", "").replace(">", ""),
                "privacyStatus": "public",
                "shouldNotifySubscribers": False,
            }
        )
    return target


def blotato_request(
    row: dict[str, Any], channel: Channel, *, media_url: str | None, account_id: str = ""
) -> dict[str, Any]:
    """One post for one Blotato channel. The platform is the channel's ``kind``; the account is the
    channel's own (migration 055), falling back to the user's Blotato row for channels made before
    that. The social text is cut to the platform's limit with its link kept."""
    platform = channel.kind
    text = str(row.get("linkedin_content") or "") or blog_body(str(row.get("body_md") or ""))
    return {
        "post": {
            "accountId": str(channel.config.get("account_id") or account_id or "").strip(),
            "content": {
                "text": fit_text(text, TEXT_LIMITS.get(platform, LINKEDIN_MAX_CHARS)),
                "platform": platform,
                "mediaUrls": [media_url] if media_url else [],
            },
            "target": blotato_target(channel, row, has_media=bool(media_url)),
        }
    }


def blotato_problem(channel: Channel, request: dict[str, Any]) -> str | None:
    """Why Blotato would refuse this post on this platform, before anything is sent; None if fine."""
    platform = channel.kind
    name = PLATFORM_LABEL.get(platform, platform)
    if platform in VIDEO_ONLY:
        return f"{name} takes video only; the calendar has nothing to post there"
    if platform in NEEDS_IMAGE and not request["post"]["content"]["mediaUrls"]:
        return f"{name} needs an image: turn on the sketchnote image or choose one for this post"
    if platform == "facebook" and not request["post"]["target"].get("pageId"):
        return "Facebook posts go to a page: switch a Facebook page on in Settings → Integrations"
    if platform == "pinterest" and not request["post"]["target"].get("boardId"):
        return "Pinterest pins go to a board: switch a board on in Settings → Integrations"
    return None


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


NO_BLOTATO_KEY = "no Blotato API key is set for this user (Settings → Integrations → Blotato)"


def website_problem(channel: Channel, token: str) -> str | None:
    """Why this website channel cannot be sent, before any network call; None when it can."""
    if not str(channel.config.get("endpoint") or "").strip():
        return f"channel {channel.channel}: no endpoint configured"
    if not token:
        return (
            f"channel {channel.channel}: no auth token is set for this website "
            "(Settings → Integrations → Website blogs)"
        )
    return None


async def send_website(
    http: httpx.AsyncClient,
    channel: Channel,
    request: dict[str, Any],
    *,
    token: str,
    resolve: Resolver | None = None,
) -> SendResult:
    endpoint = str(channel.config.get("endpoint") or "").strip()
    header = str(channel.config.get("auth_header") or "Authorization").strip()
    problem = website_problem(channel, token)
    if problem:
        return SendResult("failed", detail=problem)
    unsafe = await check_public_https_url(endpoint, resolve=resolve)
    if unsafe:
        return SendResult("failed", detail=f"channel {channel.channel}: endpoint refused: {unsafe}")
    value = (
        token
        if header.lower() != "authorization" or token.lower().startswith("bearer ")
        else f"Bearer {token}"
    )
    # No redirects: the token must not follow a 30x anywhere. The check above gives the user a
    # readable reason; the connection itself is checked again by the caller's safe client
    # (writer_engine.safe_http), which is what defeats a DNS answer that changes in between.
    try:
        resp = await http.post(
            endpoint, json=request, headers={header: value}, timeout=60.0, follow_redirects=False
        )
    except UnsafeDestinationError as exc:
        return SendResult("failed", detail=f"channel {channel.channel}: endpoint refused: {exc}")
    data = _json(resp)
    if 300 <= resp.status_code < 400:
        where = resp.headers.get("location", "")[:200]
        return SendResult(
            "failed", detail=f"HTTP {resp.status_code}: endpoint redirects ({where}); not followed"
        )
    if resp.status_code >= 400:
        return SendResult("failed", detail=f"HTTP {resp.status_code}: {_short(data)}", response=data)
    url = website_public_url(channel, data)
    dup = " (already existed)" if data.get("duplicate") else ""
    return SendResult("published", public_url=url, detail=f"posted to {channel.label}{dup}", response=data)


def _blotato_headers(api_key: str) -> dict[str, str]:
    return {"blotato-api-key": api_key, "Content-Type": "application/json"}


async def send_blotato(
    http: httpx.AsyncClient, channel: Channel, request: dict[str, Any], *, api_key: str, base_url: str
) -> SendResult:
    if not api_key:
        return SendResult("failed", detail=NO_BLOTATO_KEY)
    if not request["post"]["accountId"]:
        return SendResult(
            "failed",
            detail=f"channel {channel.channel}: no Blotato account for it (switch it on in Settings → Integrations)",
        )
    problem = blotato_problem(channel, request)
    if problem:
        return SendResult("failed", detail=f"channel {channel.channel}: {problem}")
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


send_linkedin = send_blotato


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
            if state in ("success", "fail", "error", "failed"):
                _record_kie_cost(str(task_id), data, succeeded=state == "success")
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
    except Exception as exc:  # noqa: BLE001 - an image is decoration; the post goes out without it
        logger.warning("social.image_failed", error=f"{type(exc).__name__}: {exc}"[:200])
        return None


def _record_kie_cost(task_id: str, data: dict[str, Any], *, succeeded: bool) -> None:
    """One cost row per KIE sketchnote task, from KIE's own ``creditsConsumed``."""
    from writer_engine.telemetry import token_accounting

    raw = data.get("creditsConsumed")
    try:
        credits = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        credits = None
    if not succeeded and not credits:
        return
    token_accounting.record_units(
        provider="kieai",
        model="google/nano-banana",
        units=1 if succeeded else 0,
        unit_type="images",
        credits=credits,
        request_id=task_id,
        metadata={"state": data.get("state"), "purpose": "social.sketchnote"},
    )


def _json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        return {"raw": resp.text[:500]}
    return data if isinstance(data, dict) else {"data": data}


def _short(data: dict[str, Any]) -> str:
    return json.dumps(data)[:300]
