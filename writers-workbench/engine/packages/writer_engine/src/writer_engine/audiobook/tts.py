"""One call to the speech provider: text + a voice + direction -> MP3 bytes."""

from __future__ import annotations

import re
from typing import Any

import httpx

from writer_engine.config import get_settings
from writer_engine.errors import HTTP_ERRORS
from writer_engine.rate_limit.provider_budget import call_provider

OPENAI_SPEECH = "https://api.openai.com/v1/audio/speech"
DEFAULT_MODEL = "gpt-4o-mini-tts"

# The voices the model offers. `marin` and `cedar` are the provider's recommended, most natural pair.
VOICES: tuple[str, ...] = (
    "marin",
    "cedar",
    "ash",
    "ballad",
    "coral",
    "echo",
    "nova",
    "onyx",
    "sage",
    "shimmer",
    "verse",
    "alloy",
)
DEFAULT_VOICE = "marin"


class TTSError(RuntimeError):
    """The speech provider could not narrate this text."""


async def synthesize(
    text: str,
    *,
    voice: str,
    instructions: str,
    model: str = DEFAULT_MODEL,
    client: httpx.AsyncClient | None = None,
) -> bytes:
    key = get_settings().openai_api_key
    if not key:
        raise TTSError("OPENAI_API_KEY is not set on the engine")
    body = {
        "model": model,
        "voice": voice if voice in VOICES else DEFAULT_VOICE,
        "input": text,
        "instructions": instructions,
        "response_format": "mp3",
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    async def _post(c: httpx.AsyncClient) -> bytes:
        r = await c.post(OPENAI_SPEECH, headers=headers, json=body)
        r.raise_for_status()
        if not r.content:
            raise TTSError("the speech provider returned no audio")
        return r.content

    async def _call() -> bytes:
        if client is not None:
            return await _post(client)
        async with httpx.AsyncClient(timeout=180.0) as c:
            return await _post(c)

    try:
        # About 4 characters a token; the provider budget gate is token-shaped.
        return await call_provider("openai", _call, model=model, input_tokens=max(1, len(text) // 4))
    except TTSError:
        raise
    except HTTP_ERRORS as exc:
        raise TTSError(f"speech provider error: {type(exc).__name__}: {exc}"[:300]) from exc


# ----------------------------------------------------------------------------- ElevenLabs
# The author's own ElevenLabs account (their key, their plan, their voices — including a clone of their
# own voice). Same narration pipeline downstream; only the speech call differs.

ELEVEN_SPEECH = "https://api.elevenlabs.io/v1/text-to-speech"
ELEVEN_MODEL = "eleven_multilingual_v2"
ELEVEN_FORMAT = "mp3_44100_128"
_ELEVEN_VOICE_ID = re.compile(r"^[A-Za-z0-9]{8,40}$")

# ElevenLabs has no free-text direction, so the delivery styles become its numbers. Lower stability is
# a more varied, more expressive read; higher style exaggerates the voice's own character.
ELEVEN_STYLE_SETTINGS: dict[str, dict[str, Any]] = {
    "fiction": {"stability": 0.40, "similarity_boost": 0.85, "style": 0.35, "use_speaker_boost": True},
    "thriller": {"stability": 0.50, "similarity_boost": 0.85, "style": 0.25, "use_speaker_boost": True},
    "intimate": {"stability": 0.60, "similarity_boost": 0.85, "style": 0.15, "use_speaker_boost": True},
    "epic": {"stability": 0.32, "similarity_boost": 0.85, "style": 0.50, "use_speaker_boost": True},
}


def eleven_settings(style: str) -> dict[str, Any]:
    return dict(ELEVEN_STYLE_SETTINGS.get(style) or ELEVEN_STYLE_SETTINGS["fiction"])


def valid_eleven_voice(voice_id: str) -> bool:
    return bool(_ELEVEN_VOICE_ID.match(voice_id or ""))


def _eleven_problem(exc: httpx.HTTPStatusError) -> str:
    """What ElevenLabs refused, in words the author can act on. Never includes the key."""
    status = exc.response.status_code
    try:
        detail = exc.response.json().get("detail")
        code = (detail or {}).get("status", "") if isinstance(detail, dict) else ""
    except ValueError:
        code = ""
    if status in (401, 403):
        return "ElevenLabs refused your API key (or it lacks text-to-speech permission) — reconnect it"
    if status == 402 or "quota" in code:
        return "your ElevenLabs plan is out of characters (or the voice needs a paid plan)"
    if status in (404, 422) and "voice" in code:
        return "that voice is not in your ElevenLabs account"
    return f"ElevenLabs error {status}"


async def synthesize_elevenlabs(
    text: str,
    *,
    voice_id: str,
    api_key: str,
    style: str,
    previous_text: str = "",
    next_text: str = "",
    client: httpx.AsyncClient | None = None,
) -> bytes:
    if not api_key:
        raise TTSError("connect your ElevenLabs API key first")
    if not valid_eleven_voice(voice_id):
        raise TTSError("choose one of your ElevenLabs voices")
    body: dict[str, Any] = {
        "text": text,
        "model_id": ELEVEN_MODEL,
        "voice_settings": eleven_settings(style),
    }
    # The neighbouring text lets the voice carry its pacing and intonation across the chunk boundary.
    if previous_text:
        body["previous_text"] = previous_text[-400:]
    if next_text:
        body["next_text"] = next_text[:400]
    url = f"{ELEVEN_SPEECH}/{voice_id}?output_format={ELEVEN_FORMAT}"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"}

    async def _post(c: httpx.AsyncClient) -> bytes:
        r = await c.post(url, headers=headers, json=body)
        r.raise_for_status()
        if not r.content:
            raise TTSError("ElevenLabs returned no audio")
        return r.content

    async def _call() -> bytes:
        if client is not None:
            return await _post(client)
        async with httpx.AsyncClient(timeout=180.0) as c:
            return await _post(c)

    try:
        return await call_provider(
            "elevenlabs", _call, model=ELEVEN_MODEL, input_tokens=max(1, len(text) // 4)
        )
    except TTSError:
        raise
    except httpx.HTTPStatusError as exc:
        raise TTSError(_eleven_problem(exc)) from None
    except HTTP_ERRORS as exc:
        raise TTSError(f"ElevenLabs error: {type(exc).__name__}"[:200]) from None
