"""One call to the speech provider: text + a voice + direction -> MP3 bytes."""

from __future__ import annotations

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
