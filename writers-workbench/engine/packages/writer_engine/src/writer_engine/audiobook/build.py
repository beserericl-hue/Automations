"""One audiobook recording, end to end.

The server writes a row (``audiobook_chapters_v2``) holding the text to narrate and queues this job
with the row's id. The job narrates it, masters it, stores the MP3 and writes back what it made. The
row is the contract: the screen reads it, and a job that dies leaves ``building`` behind for the
server to call interrupted rather than a half-written file.

Kinds: ``opening`` / ``chapter`` / ``closing`` are narrated from the row's text; ``sample`` is cut from
the book's first finished chapter (the retail sample is part of the book, not a separate reading).
"""

from __future__ import annotations

import asyncio
import base64
from datetime import UTC, datetime
from typing import Any

import httpx

from writer_engine.audiobook import master, styles, text, tts
from writer_engine.telemetry import token_accounting
from writer_engine.telemetry.logging import get_logger

logger = get_logger("audiobook")

BUCKET = "audiobooks"
# Chunks of one chapter narrated at once. The provider allows far more; this keeps one chapter from
# starving the others when a whole book is queued.
CHUNK_CONCURRENCY = 4
SAMPLE_SECONDS = 180.0
PREVIEW_MAX_CHARS = 700


class BuildError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def _one(query: Any) -> dict[str, Any] | None:
    res = await query.limit(1).execute()
    rows = res.data or []
    return rows[0] if rows else None


async def _narrate(
    segs: list[text.Segment], *, voice: str, instructions: str, model: str
) -> list[bytes | float]:
    """The speech for every chunk, in order, with the pauses left as seconds."""
    sem = asyncio.Semaphore(CHUNK_CONCURRENCY)
    async with httpx.AsyncClient(timeout=180.0) as http:

        async def one(s: text.Segment) -> bytes:
            async with sem:
                return await tts.synthesize(
                    s.text, voice=voice, instructions=instructions, model=model, client=http
                )

        tasks = [asyncio.create_task(one(s)) if not s.is_pause else None for s in segs]
        try:
            out: list[bytes | float] = []
            for s, t in zip(segs, tasks, strict=True):
                out.append(s.seconds if t is None else await t)
            return out
        except BaseException:
            for t in tasks:
                if t is not None and not t.done():
                    t.cancel()
            raise


async def _download(client: Any, path: str) -> bytes:
    data = await client.storage.from_(BUCKET).download(path)
    if not data:
        raise BuildError("MISSING_FILE", f"the recording {path} is not in storage")
    return bytes(data)


async def _upload(client: Any, path: str, mp3: bytes) -> None:
    await client.storage.from_(BUCKET).upload(
        path, mp3, file_options={"content-type": "audio/mpeg", "x-upsert": "true"}
    )


def storage_path(user_id: str, book_id: str, position: int, kind: str) -> str:
    return f"{user_id}/{book_id}/{position:03d}_{kind}.mp3"


async def build_item(item_id: str, user_id: str, tags: dict[str, str] | None = None) -> dict[str, Any]:
    """Build one recording. Always leaves the row ``ready`` or ``failed``; raises only ``BuildError``."""
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    item = await _one(client.table("audiobook_chapters_v2").select("*").eq("id", item_id))
    book = (
        await _one(client.table("audiobooks_v2").select("*").eq("id", item["audiobook_id"])) if item else None
    )
    if not item or not book or str(book.get("user_id")) != str(user_id):
        raise BuildError("NOT_FOUND", "that recording does not exist")
    if not master.available():
        raise BuildError("FFMPEG_MISSING", "ffmpeg is not installed on the engine")

    await (
        client.table("audiobook_chapters_v2")
        .update({"status": "building", "error": None, "started_at": _now(), "updated_at": _now()})
        .eq("id", item_id)
        .execute()
    )
    try:
        kind = str(item["kind"])
        # ID3 tags: what the row knows is the default; whatever the server sent (the book's title and
        # author, the track's place in the listing order) wins.
        meta = {
            "title": str(item.get("title") or ""),
            "track": str(int(item.get("position") or 0) + 1),
            "genre": "Audiobook",
            **{k: str(v) for k, v in (tags or {}).items()},
        }
        chars = 0
        model = str(book.get("model") or tts.DEFAULT_MODEL)
        if kind == "sample":
            first = await _one(
                client.table("audiobook_chapters_v2")
                .select("storage_path")
                .eq("audiobook_id", item["audiobook_id"])
                .eq("kind", "chapter")
                .eq("status", "ready")
                .order("position")
            )
            if not first or not first.get("storage_path"):
                raise BuildError("NO_CHAPTER", "build the first chapter before the retail sample")
            result = await master.sample_from(
                await _download(client, str(first["storage_path"])), seconds=SAMPLE_SECONDS, tags=meta
            )
        else:
            guide = book.get("pronunciations")
            title_line = (
                text.apply_pronunciations(str(item.get("title") or ""), guide) if kind == "chapter" else ""
            )
            segs = text.segments(
                text.apply_pronunciations(str(item.get("source_text") or ""), guide), title_line=title_line
            )
            chars = text.speech_chars(segs)
            if not chars:
                raise BuildError("NO_TEXT", "there is no text to narrate")
            instructions = styles.instructions_for(
                str(book.get("style") or styles.DEFAULT_STYLE), str(book.get("custom_style") or "")
            )
            parts = await _narrate(
                segs,
                voice=str(item.get("voice") or book.get("voice") or tts.DEFAULT_VOICE),
                instructions=instructions,
                model=model,
            )
            result = await master.master(parts, tags=meta)
            token_accounting.record_units(
                provider="openai",
                model=model,
                units=round(result.duration_s / 60.0, 3),
                unit_type="minutes",
                operation="audiobook.narrate",
                metadata={"chars": chars, "kind": kind, "voice": str(item.get("voice") or "")},
            )

        path = storage_path(user_id, str(item["audiobook_id"]), int(item.get("position") or 0), kind)
        await _upload(client, path, result.mp3)
        done: dict[str, Any] = {
            "status": "ready",
            "storage_path": path,
            "size_bytes": len(result.mp3),
            "duration_s": result.duration_s,
            "rms_db": round(result.rms_db, 2),
            "peak_db": round(result.peak_db, 2),
            "spec_ok": result.spec_ok,
            "chars": chars,
            "error": None,
            "built_at": _now(),
            "updated_at": _now(),
        }
        await client.table("audiobook_chapters_v2").update(done).eq("id", item_id).execute()
        logger.info(
            "audiobook.built", item=item_id, kind=kind, seconds=result.duration_s, spec_ok=result.spec_ok
        )
        return {
            "item_id": item_id,
            **{k: done[k] for k in ("status", "duration_s", "rms_db", "peak_db", "spec_ok")},
        }
    except (BuildError, tts.TTSError, master.MasterError) as exc:
        message = getattr(exc, "message", None) or str(exc)
        await (
            client.table("audiobook_chapters_v2")
            .update({"status": "failed", "error": message[:500], "updated_at": _now()})
            .eq("id", item_id)
            .execute()
        )
        logger.warning("audiobook.failed", item=item_id, error=message[:200])
        raise BuildError(getattr(exc, "code", "AUDIOBOOK_FAILED"), message) from exc
    except BaseException:
        # Cancelled or crashed: do not leave `building` behind for an hour.
        await (
            client.table("audiobook_chapters_v2")
            .update(
                {
                    "status": "failed",
                    "error": "the build was interrupted — build it again",
                    "updated_at": _now(),
                }
            )
            .eq("id", item_id)
            .execute()
        )
        raise


async def preview(
    voice: str, style: str, custom_style: str, sample: str, pronunciations: object = None
) -> dict[str, Any]:
    """A short, unmastered reading in the chosen voice and style, so the author can hear it first."""
    body = text.clean(text.apply_pronunciations(sample, pronunciations))[:PREVIEW_MAX_CHARS]
    if not body:
        raise BuildError("NO_TEXT", "there is no text to read")
    mp3 = await tts.synthesize(
        body, voice=voice, instructions=styles.instructions_for(style, custom_style), model=tts.DEFAULT_MODEL
    )
    return {
        "audio_b64": base64.b64encode(mp3).decode("ascii"),
        "content_type": "audio/mpeg",
        "chars": len(body),
    }
