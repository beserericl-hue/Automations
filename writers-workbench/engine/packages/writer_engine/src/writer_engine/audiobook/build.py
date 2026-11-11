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
from collections.abc import Awaitable, Callable
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
ELEVEN_CONCURRENCY = 2
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


# One speech call: (text, text before it, text after it, shared client) -> MP3 bytes.
Speak = Callable[[str, str, str, httpx.AsyncClient], Awaitable[bytes]]


def _speaker(
    provider: str, *, voice: str, style: str, custom_style: str, model: str, eleven_key: str
) -> tuple[Speak, int]:
    """The speech function for a provider, and how many chunks of a chapter it takes at once."""
    if provider == "elevenlabs":
        # ElevenLabs plans cap concurrent requests (as low as 2-3), so stay under the lowest.
        async def eleven(t: str, prev: str, nxt: str, http: httpx.AsyncClient) -> bytes:
            return await tts.synthesize_elevenlabs(
                t,
                voice_id=voice,
                api_key=eleven_key,
                style=style,
                previous_text=prev,
                next_text=nxt,
                client=http,
            )

        return eleven, ELEVEN_CONCURRENCY
    instructions = styles.instructions_for(style, custom_style)

    async def openai(t: str, _prev: str, _nxt: str, http: httpx.AsyncClient) -> bytes:
        return await tts.synthesize(t, voice=voice, instructions=instructions, model=model, client=http)

    return openai, CHUNK_CONCURRENCY


async def _narrate(segs: list[text.Segment], *, speak: Speak, concurrency: int) -> list[bytes | float]:
    """The speech for every chunk, in order, with the pauses left as seconds."""
    sem = asyncio.Semaphore(concurrency)
    speech = [i for i, s in enumerate(segs) if not s.is_pause]
    async with httpx.AsyncClient(timeout=180.0) as http:

        async def one(i: int) -> bytes:
            pos = speech.index(i)
            prev = segs[speech[pos - 1]].text if pos > 0 else ""
            nxt = segs[speech[pos + 1]].text if pos + 1 < len(speech) else ""
            async with sem:
                return await speak(segs[i].text, prev, nxt, http)

        tasks = [asyncio.create_task(one(i)) if not s.is_pause else None for i, s in enumerate(segs)]
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
            provider = str(book.get("provider") or "openai")
            eleven_key = await _eleven_key(client, user_id) if provider == "elevenlabs" else ""
            speak, concurrency = _speaker(
                provider,
                voice=str(item.get("voice") or book.get("voice") or tts.DEFAULT_VOICE),
                style=str(book.get("style") or styles.DEFAULT_STYLE),
                custom_style=str(book.get("custom_style") or ""),
                model=model,
                eleven_key=eleven_key,
            )
            parts = await _narrate(segs, speak=speak, concurrency=concurrency)
            result = await master.master(parts, tags=meta)
            if provider == "elevenlabs":
                # Billed to the author's own ElevenLabs plan in characters; recorded for the ledger only.
                token_accounting.record_units(
                    provider="elevenlabs",
                    model=tts.ELEVEN_MODEL,
                    units=chars,
                    unit_type="characters",
                    operation="audiobook.narrate",
                    metadata={"kind": kind, "voice": str(item.get("voice") or "")},
                )
            else:
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


async def _eleven_key(client: Any, user_id: str) -> str:
    """The author's own ElevenLabs API key, decrypted from their integration settings."""
    from writer_engine.integrations import load_user_credentials

    creds = await load_user_credentials(client, user_id)
    if not creds.elevenlabs_api_key:
        raise BuildError("NO_KEY", "connect your ElevenLabs API key first")
    return creds.elevenlabs_api_key


async def preview(
    voice: str,
    style: str,
    custom_style: str,
    sample: str,
    pronunciations: object = None,
    provider: str = "openai",
    user_id: str = "",
) -> dict[str, Any]:
    """A short, unmastered reading in the chosen voice and style, so the author can hear it first."""
    body = text.clean(text.apply_pronunciations(sample, pronunciations))[:PREVIEW_MAX_CHARS]
    if not body:
        raise BuildError("NO_TEXT", "there is no text to read")
    if provider == "elevenlabs":
        from writer_engine.supabase.client import get_supabase_admin

        key = await _eleven_key(await get_supabase_admin(), user_id)
        mp3 = await tts.synthesize_elevenlabs(body, voice_id=voice, api_key=key, style=style)
    else:
        mp3 = await tts.synthesize(
            body,
            voice=voice,
            instructions=styles.instructions_for(style, custom_style),
            model=tts.DEFAULT_MODEL,
        )
    return {
        "audio_b64": base64.b64encode(mp3).decode("ascii"),
        "content_type": "audio/mpeg",
        "chars": len(body),
    }
