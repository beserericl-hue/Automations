"""Audiobook narration: what the voice is given, how it is directed, and what the mastered file is.

The speech provider is stubbed (no network, no spend); ffmpeg is real, because the loudness and peak
numbers the screen shows are MEASURED on the file, and a test over a fake master would prove nothing.
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeSupabase

from writer_engine.audiobook import build, master, styles, text, tts

needs_ffmpeg = pytest.mark.skipif(not master.available(), reason="ffmpeg/ffprobe not installed")

OWNER = "u-owner"
BOOK = "11111111-1111-1111-1111-111111111111"


# ----------------------------------------------------------------------------- text


def test_markup_is_stripped_and_never_spoken():
    segs = text.segments("# Heading\n\nShe said *nothing*, and **everything** changed. See [here](http://x).")
    spoken = " ".join(s.text for s in segs if not s.is_pause)
    assert "*" not in spoken and "#" not in spoken and "http" not in spoken
    assert "nothing, and everything changed. See here." in spoken


def test_title_is_its_own_utterance_followed_by_a_pause():
    segs = text.segments("The door opened.", title_line="Chapter 3. The Door")
    assert segs[0] == text.Segment(text="Chapter 3. The Door")
    assert segs[1] == text.Segment(seconds=text.PAUSE_AFTER_TITLE)
    assert segs[2].text == "The door opened."


def test_scene_break_is_a_long_pause_and_not_spoken():
    segs = text.segments("First scene.\n\n---\n\nSecond scene.")
    assert [s.is_pause for s in segs] == [False, True, False]
    assert segs[1].seconds == text.PAUSE_SCENE_BREAK
    assert all("-" not in s.text for s in segs)


def test_long_chapter_is_cut_at_paragraphs_never_mid_sentence_and_loses_no_words():
    paragraphs = [f"Paragraph {i}. " + "The wind carried the smell of rain. " * 40 for i in range(12)]
    body = "\n\n".join(paragraphs)
    segs = text.segments(body)
    chunks = [s.text for s in segs if not s.is_pause]
    assert len(chunks) > 1
    assert all(len(c) <= text.MAX_CHUNK_CHARS for c in chunks)
    # Every word comes back, in order.
    assert " ".join(" ".join(chunks).split()) == " ".join(" ".join(paragraphs).split())
    # Chunks end where a sentence ends.
    assert all(c.rstrip().endswith(".") for c in chunks)
    # A short pause between neighbouring chunks, so the join is not heard.
    pauses = [s.seconds for s in segs if s.is_pause]
    assert pauses and set(pauses) == {text.PAUSE_BETWEEN_CHUNKS}


def test_one_enormous_paragraph_is_still_split_inside_the_limit():
    body = "word " * 2000
    chunks = [s.text for s in text.segments(body) if not s.is_pause]
    assert len(chunks) > 1 and all(len(c) <= text.MAX_CHUNK_CHARS for c in chunks)
    assert sum(len(c.split()) for c in chunks) == 2000


# ----------------------------------------------------------------------------- direction


def test_every_style_directs_a_performance_and_forbids_changing_the_words():
    for key in styles.PRESETS:
        d = styles.instructions_for(key)
        assert "American English" in d
        assert "monotone" in d and "robotic" in d  # the direction names what to avoid
        assert "do not add, skip, repeat or paraphrase" in d


def test_unknown_style_falls_back_and_the_authors_note_is_added_and_bounded():
    assert styles.instructions_for("nope") == styles.instructions_for(styles.DEFAULT_STYLE)
    d = styles.instructions_for("fiction", "  gravelly\n and slow  " + "x" * 2000)
    assert "The author also asks: gravelly and slow" in d
    assert len(d) < len(styles.instructions_for("fiction")) + 700


# ----------------------------------------------------------------------------- mastering


def _tone_mp3(seconds: float, level: float) -> bytes:
    """Stand-in 'speech': a modulated tone at a chosen amplitude (so the leveller has work to do)."""
    import subprocess

    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "t.mp3"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency=220:duration={seconds},volume={level}",
                "-ar",
                "24000",
                "-ac",
                "1",
                str(out),
            ],
            check=True,
        )
        return out.read_bytes()


def _probe(mp3: bytes) -> dict[str, Any]:
    import json
    import subprocess

    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "o.mp3"
        f.write_bytes(mp3)
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name,sample_rate,channels,bit_rate",
                "-show_entries",
                "format_tags=title,artist",
                "-of",
                "json",
                str(f),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    return json.loads(out)


def _first_half_second(mp3: bytes, work: Path) -> Path:
    import subprocess

    src, head = work / "o.mp3", work / "head.wav"
    src.write_bytes(mp3)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-t", "0.5", "-i", str(src), str(head)],
        check=True,
    )
    return head


@needs_ffmpeg
@pytest.mark.parametrize("level", [0.02, 0.9])  # far too quiet, and far too hot
async def test_mastered_file_is_in_the_retail_spec_whatever_the_provider_returned(level: float):
    chunk = _tone_mp3(4.0, level)
    result = await master.master([chunk, 0.4, chunk, 1.8, chunk], tags={"title": "T", "artist": "A"})
    assert master.RMS_MIN_DB <= result.rms_db <= master.RMS_MAX_DB, result.rms_db
    assert result.peak_db <= master.PEAK_MAX_DB, result.peak_db
    assert result.spec_ok

    probe = _probe(result.mp3)
    stream = probe["streams"][0]
    assert stream["codec_name"] == "mp3" and stream["sample_rate"] == "44100" and stream["channels"] == 1
    assert abs(int(stream["bit_rate"]) - 192_000) < 2_000  # constant bit rate
    assert probe["format"]["tags"]["title"] == "T"
    # 12 s of speech + 2.2 s of pauses + 0.9 s head + 3 s tail of room tone.
    assert 17.5 < result.duration_s < 19.5


@needs_ffmpeg
async def test_room_tone_not_digital_silence_before_and_after_the_speech():
    chunk = _tone_mp3(2.0, 0.5)
    result = await master.master([chunk])
    with tempfile.TemporaryDirectory() as d:
        head = _first_half_second(result.mp3, Path(d))
        rms, peak = await master.measure(head)
    assert rms > -90  # not digital silence (-inf is read as -120)
    assert peak < -55  # and well under the -60 dB noise floor the spec allows


@needs_ffmpeg
async def test_sample_is_the_front_of_the_chapter_faded_out():
    chunk = _tone_mp3(8.0, 0.4)
    chapter = await master.master([chunk] * 3)
    sample = await master.sample_from(chapter.mp3, seconds=10.0)
    assert 10.0 < sample.duration_s < 16.0  # 10 s cut + the 3 s room tone
    assert sample.spec_ok


async def test_master_refuses_a_recording_with_no_speech():
    with pytest.raises(master.MasterError):
        await master.master([0.5, 1.0])


# ----------------------------------------------------------------------------- the build


class _Bits:
    narrated: list[tuple[str, str, str]]


def _db(kind: str = "chapter", source: str = "It was a dark night.\n\nThe rain fell.") -> FakeSupabase:
    db = FakeSupabase()
    db.tables["audiobooks_v2"] = [
        {
            "id": BOOK,
            "user_id": OWNER,
            "project_id": "p1",
            "volume_index": 1,
            "model": "gpt-4o-mini-tts",
            "voice": "marin",
            "style": "thriller",
            "custom_style": "",
            "credits": True,
        }
    ]
    db.tables["audiobook_chapters_v2"] = [
        {
            "id": "c1",
            "audiobook_id": BOOK,
            "kind": kind,
            "chapter_number": 1,
            "position": 1,
            "title": "Chapter 1. The Door",
            "source_text": source,
            "voice": "cedar",
            "status": "queued",
            "error": None,
        }
    ]
    return db


@pytest.fixture
def narrated(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    chunk = _tone_mp3(1.5, 0.4) if master.available() else b"x"

    async def fake_synth(
        text_: str, *, voice: str, instructions: str, model: str = "", client: Any = None
    ) -> bytes:
        calls.append({"text": text_, "voice": voice, "instructions": instructions, "model": model})
        return chunk

    monkeypatch.setattr(tts, "synthesize", fake_synth)
    return calls


def _use(monkeypatch: pytest.MonkeyPatch, db: FakeSupabase) -> None:
    async def admin() -> FakeSupabase:
        return db

    monkeypatch.setattr("writer_engine.supabase.client.get_supabase_admin", admin)


@needs_ffmpeg
async def test_build_narrates_with_the_items_voice_and_the_books_style_stores_and_records(
    monkeypatch: pytest.MonkeyPatch, narrated: list[dict[str, Any]]
):
    db = _db()
    _use(monkeypatch, db)
    out = await build.build_item("c1", OWNER, tags={"album": "The Book", "artist": "An Author"})

    assert out["status"] == "ready" and out["spec_ok"] is True
    row = db.tables["audiobook_chapters_v2"][0]
    assert row["status"] == "ready" and row["error"] is None
    assert row["storage_path"] == f"{OWNER}/{BOOK}/001_chapter.mp3"
    assert db.objects[("audiobooks", row["storage_path"])][1]["content-type"] == "audio/mpeg"
    assert row["size_bytes"] == len(db.objects[("audiobooks", row["storage_path"])][0])
    assert row["duration_s"] > 0 and master.RMS_MIN_DB <= float(row["rms_db"]) <= master.RMS_MAX_DB
    # The title was spoken first; the item's voice won; the book's style directed it.
    assert narrated[0]["text"] == "Chapter 1. The Door"
    assert {c["voice"] for c in narrated} == {"cedar"}
    assert "tense and controlled" in narrated[0]["instructions"]
    assert row["chars"] == sum(len(c["text"]) for c in narrated)


async def test_build_marks_the_row_failed_with_the_reason_when_narration_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    db = _db()
    _use(monkeypatch, db)

    async def boom(*_a: Any, **_k: Any) -> bytes:
        raise tts.TTSError("429 rate limited")

    monkeypatch.setattr(tts, "synthesize", boom)
    if not master.available():
        monkeypatch.setattr(master, "available", lambda: True)
    with pytest.raises(build.BuildError):
        await build.build_item("c1", OWNER)
    row = db.tables["audiobook_chapters_v2"][0]
    assert row["status"] == "failed" and "429 rate limited" in row["error"]
    assert not db.objects


async def test_build_cancelled_midway_does_not_leave_building_behind(monkeypatch: pytest.MonkeyPatch):
    db = _db()
    _use(monkeypatch, db)
    monkeypatch.setattr(master, "available", lambda: True)

    async def hang(*_a: Any, **_k: Any) -> bytes:
        raise asyncio.CancelledError

    monkeypatch.setattr(tts, "synthesize", hang)
    with pytest.raises(asyncio.CancelledError):
        await build.build_item("c1", OWNER)
    row = db.tables["audiobook_chapters_v2"][0]
    assert row["status"] == "failed" and "interrupted" in row["error"]


async def test_another_users_recording_is_not_found_and_untouched(monkeypatch: pytest.MonkeyPatch):
    db = _db()
    _use(monkeypatch, db)
    with pytest.raises(build.BuildError) as err:
        await build.build_item("c1", "u-someone-else")
    assert err.value.code == "NOT_FOUND"
    assert db.tables["audiobook_chapters_v2"][0]["status"] == "queued"


async def test_a_recording_with_no_text_fails_clearly(monkeypatch: pytest.MonkeyPatch):
    db = _db(source="   \n\n  ")
    db.tables["audiobook_chapters_v2"][0]["title"] = ""
    _use(monkeypatch, db)
    monkeypatch.setattr(master, "available", lambda: True)
    with pytest.raises(build.BuildError) as err:
        await build.build_item("c1", OWNER)
    assert err.value.code == "NO_TEXT"
    assert db.tables["audiobook_chapters_v2"][0]["status"] == "failed"


@needs_ffmpeg
async def test_sample_is_cut_from_the_first_finished_chapter_and_needs_one(monkeypatch: pytest.MonkeyPatch):
    db = _db(kind="sample", source="")
    db.tables["audiobook_chapters_v2"][0].update(title="Retail sample", position=9, chapter_number=0)
    _use(monkeypatch, db)
    with pytest.raises(build.BuildError) as err:
        await build.build_item("c1", OWNER)
    assert err.value.code == "NO_CHAPTER"

    chapter = (await master.master([_tone_mp3(6.0, 0.4)] * 2)).mp3
    db.objects[("audiobooks", "x/first.mp3")] = (chapter, {})
    db.tables["audiobook_chapters_v2"].append(
        {
            "id": "c0",
            "audiobook_id": BOOK,
            "kind": "chapter",
            "chapter_number": 1,
            "position": 1,
            "status": "ready",
            "storage_path": "x/first.mp3",
        }
    )
    out = await build.build_item("c1", OWNER)
    assert out["status"] == "ready"
    assert db.tables["audiobook_chapters_v2"][0]["storage_path"] == f"{OWNER}/{BOOK}/009_sample.mp3"


async def test_preview_reads_a_short_clean_excerpt(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, Any] = {}

    async def fake_synth(
        text_: str, *, voice: str, instructions: str, model: str = "", client: Any = None
    ) -> bytes:
        seen.update(text=text_, voice=voice, instructions=instructions)
        return b"mp3-bytes"

    monkeypatch.setattr(tts, "synthesize", fake_synth)
    out = await build.preview("ash", "epic", "", "*Hello* " * 400)
    assert len(seen["text"]) <= build.PREVIEW_MAX_CHARS and "*" not in seen["text"]
    assert seen["voice"] == "ash" and "grand and dramatic" in seen["instructions"]
    assert out["content_type"] == "audio/mpeg" and out["audio_b64"]


def test_the_runtime_image_installs_ffmpeg():
    dockerfile = Path(__file__).resolve().parents[1] / "services/runtime/Dockerfile"
    assert "ffmpeg" in dockerfile.read_text()
    assert shutil is not None
