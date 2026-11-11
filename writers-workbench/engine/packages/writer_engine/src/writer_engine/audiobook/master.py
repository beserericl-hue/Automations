"""Mastering: speech chunks + pauses -> one retail-spec MP3.

The audiobook retail spec (what Audible/ACX, and the stores that copy it, check on upload):

* MP3, 192 kbps constant bit rate, 44.1 kHz
* overall RMS loudness between -23 dB and -18 dB
* peaks no higher than -3 dB
* a noise floor below -60 dB, with 0.5-1 s of room tone before the first word and 1-5 s after the last

The speech provider returns 24 kHz audio at whatever level it likes, so the chunks are decoded,
joined with room tone between them (never digital silence, which a listener hears as a dropout and a
checker rejects), levelled and limited, and only then encoded. The loudness is MEASURED on the file
that results and recorded, so the screen can say what the file is rather than what it was aimed at.

Everything shells out to ffmpeg/ffprobe (installed in the runtime image).
"""

from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

SAMPLE_RATE = 44100
BITRATE = "192k"

RMS_MIN_DB = -23.0
RMS_MAX_DB = -18.0
RMS_TARGET_DB = -20.5  # the middle of the window, so there is room for the limiter to take some off
PEAK_MAX_DB = -3.0
# The limiter ceiling sits a little under the spec so the encoder's overshoot still measures <= -3 dB.
LIMIT_LINEAR = 10 ** (-3.3 / 20)

ROOM_TONE_AMPLITUDE = 0.0003  # about -70 dBFS: well under the -60 dB noise-floor limit, not silence
HEAD_ROOM_TONE_S = 0.9
TAIL_ROOM_TONE_S = 3.0

MAX_LEVEL_PASSES = 3


class MasterError(RuntimeError):
    """ffmpeg could not produce the file."""


@dataclass(frozen=True)
class Mastered:
    mp3: bytes
    duration_s: float
    rms_db: float
    peak_db: float

    @property
    def spec_ok(self) -> bool:
        return RMS_MIN_DB <= self.rms_db <= RMS_MAX_DB and self.peak_db <= PEAK_MAX_DB


def available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


async def _run(*args: str) -> str:
    """Run a command, returning its combined output. Raises ``MasterError`` on a non-zero exit."""
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    text = out.decode("utf-8", "replace")
    if proc.returncode != 0:
        raise MasterError(f"{args[0]} exited {proc.returncode}: {text[-400:]}")
    return text


async def _ffmpeg(*args: str) -> str:
    return await _run("ffmpeg", "-hide_banner", "-nostats", "-loglevel", "info", "-y", *args)


async def _to_wav(src: Path, dst: Path) -> None:
    await _ffmpeg("-i", str(src), "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(dst))


async def _room_tone(dst: Path, seconds: float) -> None:
    await _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        f"anoisesrc=d={seconds}:c=pink:r={SAMPLE_RATE}:a={ROOM_TONE_AMPLITUDE}",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(dst),
    )


async def _concat(paths: list[Path], dst: Path) -> None:
    listing = dst.with_suffix(".txt")
    listing.write_text("".join(f"file '{p}'\n" for p in paths), encoding="utf-8")
    await _ffmpeg("-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(dst))


_RMS = re.compile(r"RMS level dB:\s*(-?\d+(?:\.\d+)?|-inf)")
_PEAK = re.compile(r"Peak level dB:\s*(-?\d+(?:\.\d+)?|-inf)")


def _num(raw: str) -> float:
    return -120.0 if raw == "-inf" else float(raw)


async def measure(path: Path) -> tuple[float, float]:
    """(overall RMS dB, peak dB) of the whole file, silence included — how the spec measures it."""
    out = await _ffmpeg("-i", str(path), "-af", "astats=metadata=0:reset=0", "-f", "null", "-")
    rms, peak = _RMS.findall(out), _PEAK.findall(out)
    if not rms or not peak:
        raise MasterError("could not measure the audio level")
    # "Overall" is printed after the per-channel blocks, so the last reading is the whole file.
    return _num(rms[-1]), _num(peak[-1])


async def duration(path: Path) -> float:
    out = await _run(
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)
    )
    try:
        return round(float(out.strip().splitlines()[-1]), 2)
    except (ValueError, IndexError) as exc:
        raise MasterError("could not read the audio duration") from exc


def _chain(gain_db: float) -> str:
    # Rumble off, a gentle compressor (speech has a wide range; audiobooks are listened to in cars and
    # on trains), the make-up gain that lands the level, then a hard ceiling for the peaks.
    return (
        "highpass=f=70,"
        "acompressor=threshold=0.125:ratio=2.5:attack=8:release=120:makeup=1,"
        f"volume={gain_db:.2f}dB,"
        f"alimiter=limit={LIMIT_LINEAR:.4f}:attack=3:release=40:level=0"
    )


async def _level(joined: Path, work: Path) -> Path:
    """Level ``joined`` into the loudness window. Returns the levelled WAV."""
    probe = work / "level0.wav"
    await _ffmpeg("-i", str(joined), "-af", _chain(0.0), str(probe))
    rms, _ = await measure(probe)
    gain = RMS_TARGET_DB - rms
    out = probe
    for i in range(1, MAX_LEVEL_PASSES + 1):
        out = work / f"level{i}.wav"
        await _ffmpeg("-i", str(joined), "-af", _chain(gain), str(out))
        rms, _ = await measure(out)
        # Inside the window with half a dB to spare on both sides is done.
        if RMS_MIN_DB + 0.5 <= rms <= RMS_MAX_DB - 0.5:
            break
        gain += RMS_TARGET_DB - rms
    return out


async def _encode(wav: Path, dst: Path, tags: dict[str, str]) -> None:
    meta: list[str] = []
    for key, value in tags.items():
        if value:
            meta += ["-metadata", f"{key}={value}"]
    await _ffmpeg(
        "-i",
        str(wav),
        "-c:a",
        "libmp3lame",
        "-b:a",
        BITRATE,
        "-ar",
        str(SAMPLE_RATE),
        "-ac",
        "1",
        "-id3v2_version",
        "3",
        *meta,
        str(dst),
    )


async def _finish(parts: list[Path], work: Path, tags: dict[str, str]) -> Mastered:
    joined = work / "joined.wav"
    await _concat(parts, joined)
    levelled = await _level(joined, work)
    mp3 = work / "out.mp3"
    await _encode(levelled, mp3, tags)
    rms, peak = await measure(mp3)
    return Mastered(mp3=mp3.read_bytes(), duration_s=await duration(mp3), rms_db=rms, peak_db=peak)


async def master(parts: list[bytes | float], *, tags: dict[str, str] | None = None) -> Mastered:
    """Join speech chunks (MP3 bytes) and pauses (seconds) into one mastered MP3.

    Room tone is added before the first word and after the last, as the spec asks.
    """
    if not any(isinstance(p, bytes) for p in parts):
        raise MasterError("there is no speech to master")
    with tempfile.TemporaryDirectory(prefix="audiobook-") as tmp:
        work = Path(tmp)
        tones: dict[float, Path] = {}

        async def tone(seconds: float) -> Path:
            if seconds not in tones:
                tones[seconds] = work / f"tone-{len(tones)}.wav"
                await _room_tone(tones[seconds], seconds)
            return tones[seconds]

        files: list[Path] = [await tone(HEAD_ROOM_TONE_S)]
        n = 0
        for part in parts:
            if isinstance(part, bytes):
                src = work / f"chunk-{n}.mp3"
                src.write_bytes(part)
                wav = work / f"chunk-{n}.wav"
                await _to_wav(src, wav)
                files.append(wav)
                n += 1
            else:
                files.append(await tone(round(max(0.05, part), 2)))
        files.append(await tone(TAIL_ROOM_TONE_S))
        return await _finish(files, work, tags or {})


async def sample_from(mp3: bytes, *, seconds: float = 180.0, tags: dict[str, str] | None = None) -> Mastered:
    """The retail sample: the first ``seconds`` of an already-mastered recording, faded out."""
    with tempfile.TemporaryDirectory(prefix="audiobook-") as tmp:
        work = Path(tmp)
        src = work / "in.mp3"
        src.write_bytes(mp3)
        total = await duration(src)
        length = min(seconds, total)
        cut = work / "cut.wav"
        fade = max(0.0, length - 3.0)
        await _ffmpeg(
            "-t",
            f"{length}",
            "-i",
            str(src),
            "-af",
            f"afade=t=out:st={fade:.2f}:d=3",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(cut),
        )
        tail = work / "tail.wav"
        await _room_tone(tail, TAIL_ROOM_TONE_S)
        return await _finish([cut, tail], work, tags or {})
