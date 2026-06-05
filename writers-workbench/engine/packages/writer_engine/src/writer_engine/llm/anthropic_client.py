"""Anthropic adapter — async, with prompt caching on the system block + token accounting."""

from __future__ import annotations

from anthropic import AsyncAnthropic

from writer_engine.config import get_settings
from writer_engine.telemetry.metrics import LLM_CALLS, LLM_TOKENS

from .router import LLMResponse


class AnthropicAdapter:
    """Thin async Anthropic adapter. Caches the ``system`` block when ``cache_system=True``."""

    provider: str = "anthropic"

    def __init__(self, *, api_key: str | None = None, service: str = "writer-engine") -> None:
        settings = get_settings()
        key = api_key or settings.anthropic_api_key
        if not key:
            raise RuntimeError("Anthropic not configured — set ANTHROPIC_API_KEY")
        # 429 backstop: the SDK retries with exponential backoff honoring Retry-After. The Redis
        # budget keeps us under the per-minute limit; this catches residual bursts (CR-003 scaling).
        self._client = AsyncAnthropic(api_key=key, max_retries=settings.anthropic_max_retries)
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
        stream: bool = False,
    ) -> LLMResponse:
        system_blocks: list[dict[str, object]] | None = None
        if system:
            block: dict[str, object] = {"type": "text", "text": system}
            if cache_system:
                block["cache_control"] = {"type": "ephemeral"}
            system_blocks = [block]

        kwargs: dict[str, object] = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system_blocks is not None:
            kwargs["system"] = system_blocks

        # Streaming is required for large outputs (a full-novel outline needs >16k tokens, which the
        # non-streaming API refuses as "may take >10 minutes"). Stream accumulates the whole message
        # so the caller still gets one LLMResponse, and it never truncates mid-JSON.
        try:
            if stream:
                async with self._client.messages.stream(**kwargs) as s:  # type: ignore[call-overload]
                    msg = await s.get_final_message()
            else:
                msg = await self._client.messages.create(**kwargs)  # type: ignore[call-overload]
        except Exception:
            LLM_CALLS.labels(service=self._service, provider=self.provider, model=model, status="error").inc()
            raise

        text = "".join(
            getattr(block, "text", "") for block in msg.content if getattr(block, "type", "") == "text"
        )
        usage = getattr(msg, "usage", None)
        input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
        cache_read = int(getattr(usage, "cache_read_input_tokens", 0) or 0)
        cache_write = int(getattr(usage, "cache_creation_input_tokens", 0) or 0)

        LLM_CALLS.labels(service=self._service, provider=self.provider, model=model, status="ok").inc()
        for kind, count in (
            ("input", input_tokens),
            ("output", output_tokens),
            ("cache_read", cache_read),
            ("cache_write", cache_write),
        ):
            if count:
                LLM_TOKENS.labels(service=self._service, provider=self.provider, model=model, kind=kind).inc(
                    count
                )

        return LLMResponse(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            model=model,
            provider=self.provider,
        )
