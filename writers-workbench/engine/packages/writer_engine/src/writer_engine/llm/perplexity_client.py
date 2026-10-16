"""Perplexity adapter — OpenAI-compatible chat API used by the research module."""

from __future__ import annotations

import httpx

from writer_engine.config import get_settings
from writer_engine.rate_limit.retry import with_retry
from writer_engine.telemetry.metrics import LLM_CALLS, LLM_TOKENS

from .router import LLMResponse


class PerplexityAdapter:
    provider: str = "perplexity"

    def __init__(self, *, api_key: str | None = None, service: str = "writer-engine") -> None:
        key = api_key or get_settings().perplexity_api_key
        if not key:
            raise RuntimeError("Perplexity not configured — set PERPLEXITY_API_KEY")
        self._api_key = key
        self._client = httpx.AsyncClient(timeout=60.0)
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
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        body = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

        async def _post() -> httpx.Response:
            resp = await self._client.post(
                "https://api.perplexity.ai/chat/completions",
                headers={"authorization": f"Bearer {self._api_key}", "content-type": "application/json"},
                json=body,
            )
            # Inside the retried callable: raise_for_status is what turns a 429 into the exception
            # with_retry can recognise. Outside it, a 429 would be returned as a success.
            resp.raise_for_status()
            return resp

        try:
            # B8: this adapter had NO retry, so one 429 failed a whole research run.
            resp = await with_retry(_post, provider=self.provider, model=model)
        except Exception:
            LLM_CALLS.labels(service=self._service, provider=self.provider, model=model, status="error").inc()
            raise
        payload = resp.json()
        text = payload["choices"][0]["message"]["content"]
        usage = payload.get("usage", {})
        input_tokens = int(usage.get("prompt_tokens", 0))
        output_tokens = int(usage.get("completion_tokens", 0))
        citations = tuple(str(c) for c in (payload.get("citations") or []) if c)

        LLM_CALLS.labels(service=self._service, provider=self.provider, model=model, status="ok").inc()
        if input_tokens:
            LLM_TOKENS.labels(service=self._service, provider=self.provider, model=model, kind="input").inc(
                input_tokens
            )
        if output_tokens:
            LLM_TOKENS.labels(service=self._service, provider=self.provider, model=model, kind="output").inc(
                output_tokens
            )

        return LLMResponse(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model,
            provider=self.provider,
            citations=citations,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
