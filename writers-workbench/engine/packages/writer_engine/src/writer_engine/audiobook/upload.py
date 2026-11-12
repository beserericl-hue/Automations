"""Saving a big audiobook file to storage without betting the whole file on one request.

A chapter recording is tens of MB and a whole-volume ``.m4b`` can be several hundred. Sending that as one
HTTP request means one dropped connection throws it all away, and holding it in memory twice (the file and
the request body) is what a small container least wants. Supabase Storage's resumable (TUS) endpoint takes
the file in 6 MB pieces, can be asked how much it already has, and so can be resumed after a failure.

Small files still go as one ordinary upload. The choice is by size, not by caller.
"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import Any

import httpx

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("audiobook.upload")

# Supabase requires every piece but the last to be exactly 6 MiB.
TUS_CHUNK = 6 * 1024 * 1024
# At or above this a file goes by pieces; below it, one request is fine and cheaper.
RESUMABLE_OVER = 40_000_000
RETRIES_PER_PIECE = 5


class UploadError(RuntimeError):
    """Storage refused or lost the file. ``too_large`` is the size-limit refusal."""

    def __init__(self, message: str, *, too_large: bool = False) -> None:
        super().__init__(message)
        self.too_large = too_large


def source_size(source: Path | bytes) -> int:
    return len(source) if isinstance(source, bytes) else source.stat().st_size


def _meta(**kv: str) -> str:
    return ",".join(f"{k} {base64.b64encode(v.encode()).decode()}" for k, v in kv.items())


def _refusal(r: httpx.Response) -> UploadError:
    text = r.text[:300]
    big = r.status_code == 413 or "exceeded the maximum allowed size" in text or "EntityTooLarge" in text
    return UploadError(f"storage answered {r.status_code}: {text}", too_large=big)


async def upload_resumable(
    *,
    bucket: str,
    path: str,
    source: Path | bytes,
    content_type: str,
    client: httpx.AsyncClient | None = None,
    base_url: str | None = None,
    key: str | None = None,
    chunk: int = TUS_CHUNK,
    sleep: Any = asyncio.sleep,
) -> int:
    """Upload ``source`` (a file path or bytes) to ``bucket/path`` in pieces. Returns the bytes stored."""
    settings = get_settings()
    base = (base_url or settings.supabase_url or "").rstrip("/")
    secret = key or settings.supabase_service_role_key
    if not base or not secret:
        raise UploadError("Supabase is not configured on the engine")
    size = source_size(source)
    # x-upsert on EVERY request, not only the first: a re-narrated recording replaces the earlier file, and
    # storage answers the first piece with 409 "resource already exists" unless the piece carries it too.
    headers = {"Authorization": f"Bearer {secret}", "apikey": secret, "Tus-Resumable": "1.0.0", "x-upsert": "true"}

    async def read(offset: int, n: int) -> bytes:
        if isinstance(source, bytes):
            return source[offset : offset + n]

        def _read() -> bytes:
            with source.open("rb") as f:
                f.seek(offset)
                return f.read(n)

        return await asyncio.to_thread(_read)

    owns = client is None
    http = client or httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=30.0))
    try:
        created = await http.post(
            f"{base}/storage/v1/upload/resumable",
            headers={
                **headers,
                "Upload-Length": str(size),
                "Upload-Metadata": _meta(
                    bucketName=bucket, objectName=path, contentType=content_type, cacheControl="3600"
                ),
            },
        )
        if created.status_code not in (200, 201):
            raise _refusal(created)
        location = created.headers.get("Location") or ""
        if not location:
            raise UploadError("storage did not say where to send the file")
        if location.startswith("/"):
            location = f"{base}{location}"

        offset = 0
        while offset < size:
            piece = await read(offset, chunk)
            for attempt in range(1, RETRIES_PER_PIECE + 1):
                try:
                    r = await http.patch(
                        location,
                        headers={
                            **headers,
                            "Content-Type": "application/offset+octet-stream",
                            "Upload-Offset": str(offset),
                        },
                        content=piece,
                    )
                    if r.status_code in (200, 204):
                        offset = int(r.headers.get("Upload-Offset", offset + len(piece)))
                        break
                    if r.status_code == 413 or (r.status_code < 500 and r.status_code != 409):
                        raise _refusal(r)
                    failure: Exception = UploadError(f"storage answered {r.status_code}: {r.text[:160]}")
                except httpx.TransportError as exc:
                    failure = exc
                if attempt == RETRIES_PER_PIECE:
                    raise UploadError(f"upload failed at {offset / 1e6:.0f} MB: {type(failure).__name__}: {failure}"[:300])
                logger.warning(
                    "audiobook.upload_retry", offset=offset, attempt=attempt, error=f"{type(failure).__name__}: {failure}"[:200]
                )
                await sleep(min(2.0**attempt, 20.0))
                # Ask storage how far it got, rather than guessing: the lost piece may have landed.
                head = await http.head(location, headers=headers)
                if head.status_code in (200, 204) and "Upload-Offset" in head.headers:
                    got = int(head.headers["Upload-Offset"])
                    if got != offset:
                        offset = got
                        if offset >= size:
                            break  # the piece we thought was lost had landed
                        piece = await read(offset, chunk)
        return size
    finally:
        if owns:
            await http.aclose()


__all__ = ["RESUMABLE_OVER", "TUS_CHUNK", "UploadError", "source_size", "upload_resumable"]
