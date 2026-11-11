"""The finished audiobook as ONE .m4b file.

A listening app such as BookPlayer treats each separate MP3 as its own book; one .m4b holds the whole
audiobook with a chapter list, the cover and the title inside it. This joins the finished recordings
(opening credits, every chapter, closing credits — never the retail sample) in listening order, with a
chapter marker at the start of each, encodes AAC at a speech bitrate, embeds the square cover, and
stores the file with the book. The recordings themselves are untouched.

The row (``audiobooks_v2.export_*``) is the contract, as for a recording: the screen reads it, and a
job that dies leaves ``building`` behind for the server to call interrupted.
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from typing import Any

from writer_engine.audiobook import master
from writer_engine.audiobook.build import BUCKET, BuildError, _download, _now, _one, too_large
from writer_engine.telemetry.logging import get_logger

logger = get_logger("audiobook.export")

# Speech needs far less than the 192 kbps retail MP3, and the narration itself has little above 12-16 kHz
# (the speech model renders 24 kHz audio; a cloned voice's 44.1 kHz MP3 has only hiss up there), so the file
# is encoded where the voice actually is:
#   compact  AAC-LC mono 48 kbps at 32 kHz (16 kHz bandwidth)  ~22 MB an hour — the default
#   high     AAC-LC mono 64 kbps at 44.1 kHz                   ~29 MB an hour
#   small    AAC-LC mono 32 kbps at 32 kHz                     ~15 MB an hour (listen first)
# (the retail MP3s are 192 kbps, ~86 MB an hour.) Both are inside the range audiobooks are normally sold in.
QUALITIES: dict[str, tuple[str, int]] = {
    "compact": ("48k", 32000),
    "high": ("64k", 44100),
    "small": ("32k", 32000),
}
DEFAULT_QUALITY = "compact"
AAC_BITRATE = QUALITIES["high"][0]
EXPORT_KINDS = ("opening", "chapter", "closing")


def file_name(title: str) -> str:
    """A URL-safe name for the .m4b, from the book's title."""
    base = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")[:80] or "audiobook"
    return f"{base}.m4b"


def _escape(value: str) -> str:
    """ffmetadata values escape = ; # \\ and newlines."""
    return re.sub(r"([=;#\\\n])", r"\\\1", value.replace("\r", ""))


def metadata_file(title: str, author: str, chapters: list[tuple[str, int, int]]) -> str:
    """The ffmetadata that gives the file its title, author and chapter list (times in milliseconds)."""
    lines = [
        ";FFMETADATA1",
        f"title={_escape(title)}",
        f"artist={_escape(author)}",
        f"album_artist={_escape(author)}",
        f"album={_escape(title)}",
        "genre=Audiobook",
        "media_type=2",
    ]
    for name, start, end in chapters:
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}", f"title={_escape(name)}"]
    return "\n".join(lines) + "\n"


async def build_export(
    audiobook_id: str,
    user_id: str,
    fingerprint: str = "",
    tags: dict[str, str] | None = None,
    quality: str = DEFAULT_QUALITY,
) -> dict[str, Any]:
    """Build the single-file audiobook. Always leaves the export ``ready`` or ``failed``."""
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    book = await _one(client.table("audiobooks_v2").select("*").eq("id", audiobook_id))
    if not book or str(book.get("user_id")) != str(user_id):
        raise BuildError("NOT_FOUND", "that audiobook does not exist")
    if not master.available():
        raise BuildError("FFMPEG_MISSING", "ffmpeg is not installed on the engine")

    async def mark(patch: dict[str, Any]) -> None:
        await (
            client.table("audiobooks_v2")
            .update({**patch, "export_updated_at": _now()})
            .eq("id", audiobook_id)
            .execute()
        )

    await mark({"export_status": "building", "export_error": None})
    try:
        res = await (
            client.table("audiobook_chapters_v2")
            .select("kind, position, title, storage_path, status")
            .eq("audiobook_id", audiobook_id)
            .order("position")
            .execute()
        )
        found: list[dict[str, Any]] = [dict(r) for r in (res.data or []) if isinstance(r, dict)]
        rows = [r for r in found if r.get("kind") in EXPORT_KINDS]
        if not rows or any(r.get("status") != "ready" or not r.get("storage_path") for r in rows):
            raise BuildError("NOT_READY", "build every recording before making the single file")

        meta = dict(tags or {})
        title = str(meta.get("album") or "Audiobook")
        author = str(meta.get("artist") or "")
        with tempfile.TemporaryDirectory(prefix="m4b-") as tmp:
            work = Path(tmp)
            parts: list[Path] = []
            chapters: list[tuple[str, int, int]] = []
            at = 0
            for i, row in enumerate(rows):
                f = work / f"{i:04d}.mp3"
                f.write_bytes(await _download(client, str(row["storage_path"])))
                length = await master.duration(f)
                end = at + round(length * 1000)
                chapters.append((str(row.get("title") or f"Part {i + 1}"), at, end))
                at = end
                parts.append(f)
            (work / "list.txt").write_text("".join(f"file '{p}'\n" for p in parts), encoding="utf-8")
            (work / "meta.txt").write_text(metadata_file(title, author, chapters), encoding="utf-8")

            cover = work / "cover.jpg"
            has_cover = False
            try:
                cover.write_bytes(await _download(client, f"{user_id}/{audiobook_id}/cover.jpg"))
                has_cover = True
            except Exception:  # noqa: BLE001 - a book without a made cover still exports, just without art
                has_cover = False

            out = work / "book.m4b"
            args = ["-f", "concat", "-safe", "0", "-i", str(work / "list.txt")]
            if has_cover:
                args += ["-i", str(cover)]
            meta_index = 2 if has_cover else 1
            args += ["-i", str(work / "meta.txt"), "-map", "0:a"]
            if has_cover:
                args += ["-map", "1:v"]
            args += ["-map_metadata", str(meta_index), "-map_chapters", str(meta_index)]
            bitrate, rate = QUALITIES.get(quality) or QUALITIES[DEFAULT_QUALITY]
            args += ["-c:a", "aac", "-b:a", bitrate, "-ar", str(rate), "-ac", "1"]
            if has_cover:
                args += ["-c:v", "copy", "-disposition:v:0", "attached_pic"]
            args += ["-movflags", "+faststart", "-f", "ipod", str(out)]
            await master._ffmpeg(*args)

            data = out.read_bytes()
            seconds = await master.duration(out)

        path = f"{user_id}/{audiobook_id}/{file_name(title)}"
        try:
            await client.storage.from_(BUCKET).upload(
                path, data, file_options={"content-type": "audio/mp4", "x-upsert": "true"}
            )
        except Exception as exc:
            if too_large(exc):
                raise BuildError(
                    "FILE_TOO_LARGE",
                    f"the audiobook file is {len(data) / 1e6:.0f} MB, more than your storage accepts in one file "
                    "(Supabase's 'Upload file size limit' defaults to 50 MB; raise it under Storage settings, "
                    "which needs a paid plan), then make the file again",
                ) from exc
            raise
        done = {
            "export_status": "ready",
            "export_error": None,
            "export_path": path,
            "export_bytes": len(data),
            "export_duration_s": seconds,
            "export_chapters": len(chapters),
            "export_hash": fingerprint or None,
            "export_quality": quality if quality in QUALITIES else DEFAULT_QUALITY,
        }
        await mark(done)
        logger.info("audiobook.exported", book=audiobook_id, chapters=len(chapters), bytes=len(data))
        return {
            "audiobook_id": audiobook_id,
            "status": "ready",
            "bytes": len(data),
            "chapters": len(chapters),
            "duration_s": seconds,
        }
    except (BuildError, master.MasterError) as exc:
        message = getattr(exc, "message", None) or str(exc)
        await mark({"export_status": "failed", "export_error": message[:500]})
        logger.warning("audiobook.export_failed", book=audiobook_id, error=message[:200])
        raise BuildError(getattr(exc, "code", "EXPORT_FAILED"), message) from exc
    except BaseException:
        await mark(
            {"export_status": "failed", "export_error": "the build was interrupted — make the file again"}
        )
        raise


__all__ = [
    "AAC_BITRATE",
    "DEFAULT_QUALITY",
    "EXPORT_KINDS",
    "QUALITIES",
    "build_export",
    "file_name",
    "metadata_file",
]
