"""Gemini adapter — the newsletter picker model per decision #2 (gemini-2.5-pro)."""

from __future__ import annotations

import google.generativeai as genai  # type: ignore[import-untyped]

from writer_engine.config import get_settings
from writer_engine.telemetry.metrics import LLM_CALLS, LLM_TOKENS

from .router import LLMResponse


class GeminiAdapter:
    """Thin async-friendly Gemini adapter. The SDK is sync-only today; we wrap in a thread."""

    provider: str = "gemini"

    def __init__(self, *, api_key: str | None = None, service: str = "writer-engine") -> None:
        key = api_key or get_settings().gemini_api_key
        if not key:
            raise RuntimeError("Gemini not configured — set GEMINI_API_KEY")
        genai.configure(api_key=key)
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
        import asyncio

        def _call() -> tuple[str, int, int]:
            gen_model = genai.GenerativeModel(model_name=model, system_instruction=system)
            response = gen_model.generate_content(
                prompt,
                generation_config={"max_output_tokens": max_tokens, "temperature": temperature},
            )
            usage = getattr(response, "usage_metadata", None)
            in_tok = int(getattr(usage, "prompt_token_count", 0) or 0)
            out_tok = int(getattr(usage, "candidates_token_count", 0) or 0)
            return response.text or "", in_tok, out_tok

        try:
            text, in_tok, out_tok = await asyncio.to_thread(_call)
        except Exception:
            LLM_CALLS.labels(service=self._service, provider=self.provider, model=model, status="error").inc()
            raise

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
