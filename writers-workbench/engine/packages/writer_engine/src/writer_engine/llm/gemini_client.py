"""Gemini adapter — the newsletter picker model per decision #2 (gemini-2.5-pro).

Built on ``google-genai``, Google's current SDK. The previous ``google-generativeai`` package is
deprecated (it logged a FutureWarning at every engine start) and was sync-only, so each call ran in a
thread; ``google-genai`` has a native async client.
"""

from __future__ import annotations

from typing import Any

from google import genai
from google.genai import types

from writer_engine.config import get_settings
from writer_engine.rate_limit.retry import with_retry
from writer_engine.telemetry.metrics import LLM_CALLS, LLM_TOKENS

from .router import LLMResponse


class GeminiAdapter:
    """Thin async Gemini adapter over ``google.genai.Client.aio``."""

    provider: str = "gemini"

    def __init__(
        self, *, api_key: str | None = None, service: str = "writer-engine", client: Any | None = None
    ) -> None:
        key = api_key or get_settings().gemini_api_key
        if not key and client is None:
            raise RuntimeError("Gemini not configured — set GEMINI_API_KEY")
        # One attempt in the SDK: ``with_retry`` below is the single retry layer, with the same
        # backoff and jitter as the other providers. Two stacked layers would multiply the attempts.
        self._client = client or genai.Client(
            api_key=key, http_options=types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=1))
        )
        self._service = service

    async def complete(
        self,
        *,
        model: str,
        system: str | None,
        prompt: str,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        cache_system: bool = True,
        stream: bool = False,  # accepted for protocol parity; ignored
    ) -> LLMResponse:
        config = types.GenerateContentConfig(
            system_instruction=system or None,
            max_output_tokens=max_tokens,
            temperature=temperature,
        )

        try:
            # B8: this adapter had NO retry, and it carries every hub turn (voice + chat), so one
            # 429 failed the user's request outright. google.genai.errors.APIError carries ``code``,
            # which is what retry.status_of reads.
            response = await with_retry(
                lambda: self._client.aio.models.generate_content(model=model, contents=prompt, config=config),
                provider=self.provider,
                model=model,
            )
        except Exception:
            LLM_CALLS.labels(service=self._service, provider=self.provider, model=model, status="error").inc()
            raise

        usage = getattr(response, "usage_metadata", None)
        in_tok = int(getattr(usage, "prompt_token_count", 0) or 0)
        out_tok = int(getattr(usage, "candidates_token_count", 0) or 0)
        text = response.text or ""

        LLM_CALLS.labels(service=self._service, provider=self.provider, model=model, status="ok").inc()
        if in_tok:
            LLM_TOKENS.labels(service=self._service, provider=self.provider, model=model, kind="input").inc(
                in_tok
            )
        if out_tok:
            LLM_TOKENS.labels(service=self._service, provider=self.provider, model=model, kind="output").inc(
                out_tok
            )

        return LLMResponse(
            text=text,
            input_tokens=in_tok,
            output_tokens=out_tok,
            model=model,
            provider=self.provider,
        )
