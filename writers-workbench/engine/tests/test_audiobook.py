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


# ----------------------------------------------------------------------------- pronunciation guide


def test_guide_respells_whole_words_only_case_sensitively_and_keeps_the_possessive():
    guide = [{"word": "Mara", "say": "Mah-rah"}, {"word": "Siobhan", "say": "Shivawn"}]
    out = text.apply_pronunciations(
        "Mara met Siobhan. Mara's coat. The marauders, and Maraud, and mara.", guide
    )
    assert out == "Mah-rah met Shivawn. Mah-rah's coat. The marauders, and Maraud, and mara."


def test_guide_matches_the_longest_entry_first_and_across_line_breaks():
    guide = [{"word": "Harrow", "say": "Hair-oh"}, {"word": "Harrow Vale", "say": "Hair-oh Vayle"}]
    assert text.apply_pronunciations("In Harrow Vale, near Harrow.\nHarrow\nVale", guide) == (
        "In Hair-oh Vayle, near Hair-oh.\nHair-oh Vayle"
    )


def test_guide_ignores_malformed_entries_and_a_replacement_is_never_reread_as_a_pattern():
    guide = [
        {"word": "", "say": "x"},
        {"word": "A", "say": ""},
        "junk",
        {"word": "Ng", "say": "\\1 (Ng)"},
        None,
    ]
    assert text.apply_pronunciations("Ng and Ng", guide) == "\\1 (Ng) and \\1 (Ng)"
    assert text.apply_pronunciations("unchanged", None) == "unchanged"
    assert text.apply_pronunciations("unchanged", "nonsense") == "unchanged"


async def test_build_narrates_the_respelling_not_the_name_and_keeps_the_manuscript(
    monkeypatch: pytest.MonkeyPatch, narrated: list[dict[str, Any]]
):
    if not master.available():
        pytest.skip("ffmpeg/ffprobe not installed")
    db = _db(source="Siobhan opened the door.")
    db.tables["audiobooks_v2"][0]["pronunciations"] = [{"word": "Siobhan", "say": "Shivawn"}]
    db.tables["audiobook_chapters_v2"][0]["title"] = "Chapter 1. Siobhan"
    _use(monkeypatch, db)
    await build.build_item("c1", OWNER)
    spoken = " ".join(c["text"] for c in narrated)
    assert "Shivawn opened the door." in spoken and "Chapter 1. Shivawn" in spoken
    assert "Siobhan" not in spoken
    assert db.tables["audiobook_chapters_v2"][0]["source_text"] == "Siobhan opened the door."


async def test_preview_applies_the_guide(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, Any] = {}

    async def fake_synth(
        text_: str, *, voice: str, instructions: str, model: str = "", client: Any = None
    ) -> bytes:
        seen["text"] = text_
        return b"mp3"

    monkeypatch.setattr(tts, "synthesize", fake_synth)
    await build.preview("ash", "fiction", "", "Siobhan.", [{"word": "Siobhan", "say": "Shivawn"}])
    assert seen["text"] == "Shivawn."


# ----------------------------------------------------------------------------- ElevenLabs (the author's own account)

FAKE_KEY = "sk_test_not_a_real_key_0123456789abcdef"
VOICE = "Kb1hixP8KFa4kdSpc4yT"


def _eleven_client(handler: Any) -> Any:
    import httpx

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_elevenlabs_request_carries_the_voice_the_key_the_style_and_the_neighbouring_text():
    import json

    seen: dict[str, Any] = {}

    def handler(request: Any) -> Any:
        import httpx

        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("xi-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"mp3-bytes")

    async with _eleven_client(handler) as c:
        out = await tts.synthesize_elevenlabs(
            "Middle.",
            voice_id=VOICE,
            api_key=FAKE_KEY,
            style="epic",
            previous_text="A" * 900,
            next_text="B" * 900,
            client=c,
        )
    assert out == b"mp3-bytes"
    assert seen["url"] == f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}?output_format=mp3_44100_128"
    assert seen["key"] == FAKE_KEY
    body = seen["body"]
    assert body["model_id"] == "eleven_multilingual_v2" and body["text"] == "Middle."
    assert body["voice_settings"]["stability"] == 0.32  # the Epic delivery: a wider, more expressive read
    assert body["previous_text"] == "A" * 400 and body["next_text"] == "B" * 400


async def test_elevenlabs_refusals_are_readable_and_never_contain_the_key():
    import httpx

    for status, detail, expect in [
        (401, {"detail": {"status": "invalid_api_key"}}, "refused your API key"),
        (402, {"detail": {"status": "quota_exceeded"}}, "out of characters"),
        (404, {"detail": {"status": "voice_not_found"}}, "not in your ElevenLabs account"),
    ]:

        def handler(request: Any, status: int = status, detail: dict = detail) -> Any:
            return httpx.Response(status, json=detail)

        async with _eleven_client(handler) as c:
            with pytest.raises(tts.TTSError) as err:
                await tts.synthesize_elevenlabs(
                    "x", voice_id=VOICE, api_key=FAKE_KEY, style="fiction", client=c
                )
        assert expect in str(err.value) and FAKE_KEY not in str(err.value)


async def test_elevenlabs_needs_a_key_and_a_well_formed_voice_id_before_any_request():
    with pytest.raises(tts.TTSError, match="connect your ElevenLabs"):
        await tts.synthesize_elevenlabs("x", voice_id=VOICE, api_key="", style="fiction")
    for bad in ["", "../../etc", "a/b", "short", "x" * 80]:
        with pytest.raises(tts.TTSError, match="choose one of your ElevenLabs voices"):
            await tts.synthesize_elevenlabs("x", voice_id=bad, api_key=FAKE_KEY, style="fiction")


async def test_build_with_elevenlabs_uses_the_authors_decrypted_key_their_voice_and_two_at_a_time(
    monkeypatch: pytest.MonkeyPatch,
):
    if not master.available():
        pytest.skip("ffmpeg/ffprobe not installed")
    from writer_engine import integrations

    key = b"k" * 32
    sealed = integrations.encrypt(FAKE_KEY, user_id=OWNER, provider="elevenlabs", channel=None, key=key)
    monkeypatch.setattr(integrations, "load_key", lambda raw=None: key)

    long_text = "\n\n".join(
        f"Paragraph {i}. " + "The wind carried the smell of rain. " * 30 for i in range(8)
    )
    db = _db(source=long_text)
    db.tables["audiobooks_v2"][0].update(provider="elevenlabs", voice=VOICE, style="epic")
    db.tables["audiobook_chapters_v2"][0]["voice"] = VOICE
    db.tables["user_integrations_v2"] = [
        {
            "user_id": OWNER,
            "provider": "elevenlabs",
            "channel": None,
            "config": {},
            "secret_ciphertext": sealed,
        }
    ]
    _use(monkeypatch, db)

    chunk = _tone_mp3(1.0, 0.4)
    calls: list[dict[str, Any]] = []
    live = {"now": 0, "max": 0}

    async def fake_eleven(
        text_: str,
        *,
        voice_id: str,
        api_key: str,
        style: str,
        previous_text: str = "",
        next_text: str = "",
        client: Any = None,
    ) -> bytes:
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
        await asyncio.sleep(0.02)
        live["now"] -= 1
        calls.append(
            {"voice": voice_id, "key": api_key, "style": style, "prev": previous_text, "next": next_text}
        )
        return chunk

    monkeypatch.setattr(tts, "synthesize_elevenlabs", fake_eleven)

    async def no_openai(*_a: Any, **_k: Any) -> bytes:
        raise AssertionError("OpenAI must not be called for an ElevenLabs book")

    monkeypatch.setattr(tts, "synthesize", no_openai)
    out = await build.build_item("c1", OWNER)
    assert out["status"] == "ready"
    assert {c["voice"] for c in calls} == {VOICE} and {c["key"] for c in calls} == {FAKE_KEY}
    assert {c["style"] for c in calls} == {"epic"}
    assert live["max"] <= build.ELEVEN_CONCURRENCY
    # continuity: every chunk but the first knows what came before it, every one but the last what follows
    assert sum(1 for c in calls if c["prev"]) == len(calls) - 1 or len(calls) == 1
    assert db.tables["audiobook_chapters_v2"][0]["status"] == "ready"


async def test_build_with_elevenlabs_and_no_connected_key_fails_clearly_without_calling_anyone(
    monkeypatch: pytest.MonkeyPatch,
):
    db = _db()
    db.tables["audiobooks_v2"][0].update(provider="elevenlabs", voice=VOICE)
    db.tables["user_integrations_v2"] = []
    _use(monkeypatch, db)
    monkeypatch.setattr(master, "available", lambda: True)
    with pytest.raises(build.BuildError) as err:
        await build.build_item("c1", OWNER)
    assert err.value.code == "NO_KEY"
    assert db.tables["audiobook_chapters_v2"][0]["status"] == "failed"
    assert "connect your ElevenLabs API key" in db.tables["audiobook_chapters_v2"][0]["error"]


async def test_preview_with_elevenlabs_uses_the_callers_key(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, Any] = {}

    async def fake_eleven(text_: str, *, voice_id: str, api_key: str, style: str, **_k: Any) -> bytes:
        seen.update(text=text_, voice=voice_id, key=api_key, style=style)
        return b"mp3"

    async def key_of(_client: Any, user_id: str) -> str:
        assert user_id == OWNER
        return FAKE_KEY

    async def admin() -> Any:
        return object()

    monkeypatch.setattr(tts, "synthesize_elevenlabs", fake_eleven)
    monkeypatch.setattr(build, "_eleven_key", key_of)
    monkeypatch.setattr("writer_engine.supabase.client.get_supabase_admin", admin)
    out = await build.preview(VOICE, "intimate", "", "Hello *there*.", None, "elevenlabs", OWNER)
    assert seen == {"text": "Hello there.", "voice": VOICE, "key": FAKE_KEY, "style": "intimate"}
    assert out["content_type"] == "audio/mpeg"


# ----------------------------------------------------------------------------- the single-file audiobook (.m4b)


def test_file_name_is_url_safe_and_metadata_escapes_what_ffmetadata_treats_as_syntax():
    from writer_engine.audiobook import export

    assert export.file_name("The Hum Beneath Harrow Vale") == "The-Hum-Beneath-Harrow-Vale.m4b"
    assert export.file_name("  ¡¿?  ") == "audiobook.m4b"
    assert len(export.file_name("x" * 500)) <= 84
    meta = export.metadata_file(
        "A=B; C#D", "Eric", [("Chapter 1. It\\'s\nodd", 0, 1500), ("Two", 1500, 4000)]
    )
    assert meta.startswith(";FFMETADATA1\n")
    assert "title=A\\=B\\; C\\#D" in meta
    assert "[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\n" in meta
    assert "START=1500\nEND=4000\ntitle=Two" in meta
    assert "\nodd" not in meta.replace("\\\n", "")  # the newline inside a title cannot start a new line


def _cover_jpg() -> bytes:
    import subprocess

    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "c.jpg"
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
                "color=c=0x1f3a5f:s=400x400",
                "-frames:v",
                "1",
                str(out),
            ],
            check=True,
        )
        return out.read_bytes()


def _probe_m4b(data: bytes) -> dict[str, Any]:
    import json
    import subprocess

    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "b.m4b"
        f.write_bytes(data)
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_chapters",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(f),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    return json.loads(out)


async def _exportable(
    monkeypatch: pytest.MonkeyPatch, *, cover: bool = True
) -> tuple[FakeSupabase, dict[str, float]]:
    """A built book of four recordings of known lengths, stored, ready to be joined."""
    db = FakeSupabase()
    db.tables["audiobooks_v2"] = [{"id": BOOK, "user_id": OWNER, "project_id": "p1", "volume_index": 1}]
    lengths = {"opening": 2.0, "c1": 5.0, "c2": 4.0, "closing": 2.0}
    plan = [
        ("opening", 0, 0, "Opening credits"),
        ("chapter", 1, 1, "Chapter 1. The Door"),
        ("chapter", 2, 2, "Chapter 2. Rain"),
        ("closing", 0, 9998, "Closing credits"),
    ]
    db.tables["audiobook_chapters_v2"] = []
    for (kind, n, pos, title), seconds in zip(plan, lengths.values(), strict=True):
        mastered = await master.master([_tone_mp3(seconds, 0.4)])
        path = f"{OWNER}/{BOOK}/{pos:03d}_{kind}.mp3"
        db.objects[("audiobooks", path)] = (mastered.mp3, {})
        db.tables["audiobook_chapters_v2"].append(
            {
                "id": f"r{pos}",
                "audiobook_id": BOOK,
                "kind": kind,
                "chapter_number": n,
                "position": pos,
                "title": title,
                "status": "ready",
                "storage_path": path,
            }
        )
    # a retail sample is never part of the book
    db.tables["audiobook_chapters_v2"].append(
        {
            "id": "rs",
            "audiobook_id": BOOK,
            "kind": "sample",
            "chapter_number": 0,
            "position": 9999,
            "title": "Retail sample",
            "status": "ready",
            "storage_path": f"{OWNER}/{BOOK}/9999_sample.mp3",
        }
    )
    if cover:
        db.objects[("audiobooks", f"{OWNER}/{BOOK}/cover.jpg")] = (_cover_jpg(), {})
    _use(monkeypatch, db)
    return db, lengths


@needs_ffmpeg
@pytest.mark.parametrize(
    ("quality", "bitrate", "rate"),
    [("compact", 48000, 32000), ("high", 64000, 44100), ("small", 32000, 32000)],
)
async def test_export_is_one_m4b_with_a_chapter_per_recording_the_cover_and_the_title_inside(
    monkeypatch: pytest.MonkeyPatch, quality: str, bitrate: int, rate: int
):
    from writer_engine.audiobook import export

    db, _ = await _exportable(monkeypatch)
    out = await export.build_export(
        BOOK, OWNER, "fp123", {"album": "The Hum Beneath Harrow Vale", "artist": "Eric Beser"}, quality
    )
    assert out["status"] == "ready" and out["chapters"] == 4

    path = f"{OWNER}/{BOOK}/The-Hum-Beneath-Harrow-Vale.m4b"
    data = db.objects[("audiobooks", path)][0]
    assert db.objects[("audiobooks", path)][1]["content-type"] == "audio/mp4"
    row = db.tables["audiobooks_v2"][0]
    assert row["export_status"] == "ready" and row["export_error"] is None
    assert (
        row["export_path"],
        row["export_bytes"],
        row["export_chapters"],
        row["export_hash"],
        row["export_quality"],
    ) == (path, len(data), 4, "fp123", quality)

    probe = _probe_m4b(data)
    audio = next(s for s in probe["streams"] if s["codec_type"] == "audio")
    assert audio["codec_name"] == "aac" and audio["channels"] == 1 and int(audio["sample_rate"]) == rate
    assert abs(int(audio["bit_rate"]) - bitrate) < bitrate * 0.15
    video = [s for s in probe["streams"] if s["codec_type"] == "video"]
    assert len(video) == 1 and video[0]["disposition"]["attached_pic"] == 1  # the cover is inside the file
    # one chapter per recording, in listening order, joined end to end, the sample not among them
    chapters = probe["chapters"]
    assert [c["tags"]["title"] for c in chapters] == [
        "Opening credits",
        "Chapter 1. The Door",
        "Chapter 2. Rain",
        "Closing credits",
    ]
    starts = [float(c["start_time"]) for c in chapters]
    ends = [float(c["end_time"]) for c in chapters]
    assert starts[0] == 0 and all(abs(starts[i + 1] - ends[i]) < 0.01 for i in range(3))
    assert abs(float(probe["format"]["duration"]) - ends[-1]) < 0.5
    # each part carries its own room tone and pauses: 2 + 5 + 4 + 2 seconds of speech, plus 3.9 s of tone each
    assert abs((ends[2] - starts[2]) - (4.0 + 0.9 + 3.0)) < 0.6
    tags = probe["format"]["tags"]
    assert (
        tags["title"] == "The Hum Beneath Harrow Vale"
        and tags["artist"] == "Eric Beser"
        and tags["genre"] == "Audiobook"
    )
    assert abs(out["duration_s"] - float(probe["format"]["duration"])) < 0.1


@needs_ffmpeg
async def test_export_sizes_follow_the_setting_and_all_are_far_smaller_than_the_retail_files(
    monkeypatch: pytest.MonkeyPatch,
):
    from writer_engine.audiobook import export

    sizes: dict[str, int] = {}
    retail = 0
    for q in ("small", "compact", "high"):
        db, _ = await _exportable(monkeypatch)
        retail = sum(
            len(db.objects[("audiobooks", r["storage_path"])][0])
            for r in db.tables["audiobook_chapters_v2"]
            if r["kind"] != "sample"
        )
        await export.build_export(BOOK, OWNER, "", {"album": "B", "artist": "A"}, q)
        sizes[q] = db.tables["audiobooks_v2"][0]["export_bytes"]
    assert sizes["small"] < sizes["compact"] < sizes["high"] < retail / 2
    assert sizes["compact"] < retail / 3


@needs_ffmpeg
async def test_export_without_a_made_cover_still_works_just_without_art(monkeypatch: pytest.MonkeyPatch):
    from writer_engine.audiobook import export

    db, _ = await _exportable(monkeypatch, cover=False)
    await export.build_export(BOOK, OWNER, "", {"album": "B", "artist": "A"})
    probe = _probe_m4b(db.objects[("audiobooks", f"{OWNER}/{BOOK}/B.m4b")][0])
    assert not [s for s in probe["streams"] if s["codec_type"] == "video"]  # no art, no picture stream
    assert len(probe["chapters"]) == 4


async def test_export_refuses_until_every_recording_is_ready_and_says_so_on_the_row(
    monkeypatch: pytest.MonkeyPatch,
):
    from writer_engine.audiobook import export

    db = FakeSupabase()
    db.tables["audiobooks_v2"] = [{"id": BOOK, "user_id": OWNER}]
    db.tables["audiobook_chapters_v2"] = [
        {
            "id": "a",
            "audiobook_id": BOOK,
            "kind": "chapter",
            "chapter_number": 1,
            "position": 1,
            "title": "One",
            "status": "ready",
            "storage_path": "x",
        },
        {
            "id": "b",
            "audiobook_id": BOOK,
            "kind": "chapter",
            "chapter_number": 2,
            "position": 2,
            "title": "Two",
            "status": "failed",
            "storage_path": None,
        },
    ]
    _use(monkeypatch, db)
    monkeypatch.setattr(master, "available", lambda: True)
    with pytest.raises(build.BuildError) as err:
        await export.build_export(BOOK, OWNER)
    assert err.value.code == "NOT_READY"
    assert db.tables["audiobooks_v2"][0]["export_status"] == "failed"
    assert "build every recording" in db.tables["audiobooks_v2"][0]["export_error"]


async def test_export_of_another_users_book_is_not_found_and_untouched(monkeypatch: pytest.MonkeyPatch):
    from writer_engine.audiobook import export

    db = FakeSupabase()
    db.tables["audiobooks_v2"] = [{"id": BOOK, "user_id": OWNER}]
    _use(monkeypatch, db)
    with pytest.raises(build.BuildError) as err:
        await export.build_export(BOOK, "someone-else")
    assert err.value.code == "NOT_FOUND"
    assert "export_status" not in db.tables["audiobooks_v2"][0]


@needs_ffmpeg
async def test_a_file_larger_than_the_storage_limit_says_what_to_change_instead_of_a_raw_error(
    monkeypatch: pytest.MonkeyPatch,
):
    import conftest

    from writer_engine.audiobook import export

    db, _ = await _exportable(monkeypatch)
    real_upload = conftest.FakeBucket.upload

    async def refuse(self: Any, path: str, content: bytes, file_options: dict[str, str] | None = None) -> Any:
        if path.endswith(".m4b"):
            raise RuntimeError(
                "{'statusCode': 413, 'error': 'Payload too large', 'message': 'The object exceeded the maximum allowed size'}"
            )
        return await real_upload(self, path, content, file_options)

    monkeypatch.setattr(conftest.FakeBucket, "upload", refuse)
    with pytest.raises(build.BuildError) as err:
        await export.build_export(BOOK, OWNER, "", {"album": "B", "artist": "A"})
    assert err.value.code == "FILE_TOO_LARGE"
    row = db.tables["audiobooks_v2"][0]
    assert row["export_status"] == "failed"
    assert "Upload file size limit" in row["export_error"] and "50 MB" in row["export_error"]


async def test_a_chapter_recording_over_the_storage_limit_gets_the_same_plain_message(
    monkeypatch: pytest.MonkeyPatch, narrated: list[dict[str, Any]]
):
    import conftest

    if not master.available():
        pytest.skip("ffmpeg/ffprobe not installed")
    db = _db()
    _use(monkeypatch, db)

    async def refuse(self: Any, path: str, content: bytes, file_options: dict[str, str] | None = None) -> Any:
        raise RuntimeError("The object exceeded the maximum allowed size")

    monkeypatch.setattr(conftest.FakeBucket, "upload", refuse)
    with pytest.raises(build.BuildError) as err:
        await build.build_item("c1", OWNER)
    assert err.value.code == "FILE_TOO_LARGE"
    assert "split the chapter" in db.tables["audiobook_chapters_v2"][0]["error"]
