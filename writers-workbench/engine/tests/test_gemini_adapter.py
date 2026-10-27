"""The Gemini adapter on google-genai: request shape, token counts, and the single retry layer."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from google.genai import errors, types

from writer_engine.llm.gemini_client import GeminiAdapter
from writer_engine.rate_limit import retry


class _Models:
    def __init__(self, outcomes: list[Any]) -> None:
        self.outcomes = outcomes
        self.calls: list[dict[str, Any]] = []

    async def generate_content(self, **kw: Any) -> Any:
        self.calls.append(kw)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _client(*outcomes: Any) -> tuple[Any, _Models]:
    models = _Models(list(outcomes))
    return SimpleNamespace(aio=SimpleNamespace(models=models)), models


def _response(text: str | None, prompt_tokens: int = 11, output_tokens: int = 7) -> Any:
    usage = SimpleNamespace(prompt_token_count=prompt_tokens, candidates_token_count=output_tokens)
    return SimpleNamespace(text=text, usage_metadata=usage)


def test_complete_sends_system_limits_and_returns_tokens() -> None:
    client, models = _client(_response("ok"))
    out = asyncio.run(
        GeminiAdapter(client=client).complete(
            model="gemini-2.5-flash", system="be brief", prompt="hi", max_tokens=99, temperature=0.0
        )
    )
    assert (out.text, out.input_tokens, out.output_tokens, out.provider) == ("ok", 11, 7, "gemini")
    call = models.calls[0]
    assert call["model"] == "gemini-2.5-flash" and call["contents"] == "hi"
    config = call["config"]
    assert isinstance(config, types.GenerateContentConfig)
    # 2.5 models think inside max_output_tokens; the answer keeps the 99 it asked for.
    assert (config.system_instruction, config.max_output_tokens, config.temperature) == (
        "be brief",
        99 + 8192,
        0.0,
    )


def test_an_empty_response_is_empty_text_not_none() -> None:
    client, _ = _client(_response(None, 3, 0))
    out = asyncio.run(GeminiAdapter(client=client).complete(model="m", system=None, prompt="hi"))
    assert out.text == ""


def test_a_429_is_retried_by_with_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _no_sleep(_s: float) -> None:
        return None

    real = retry.with_retry

    async def fast(func: Any, **kw: Any) -> Any:
        return await real(func, sleep=_no_sleep, **kw)

    monkeypatch.setattr("writer_engine.llm.gemini_client.with_retry", fast)
    rate_limited = errors.APIError(
        429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}}
    )
    assert retry.status_of(rate_limited) == 429
    client, models = _client(rate_limited, _response("second time"))
    out = asyncio.run(GeminiAdapter(client=client).complete(model="m", system=None, prompt="hi"))
    assert out.text == "second time" and len(models.calls) == 2


def test_a_bad_key_400_is_not_retried() -> None:
    bad_key = errors.APIError(
        400, {"error": {"code": 400, "message": "API key not valid", "status": "INVALID_ARGUMENT"}}
    )
    client, models = _client(bad_key)
    with pytest.raises(errors.APIError):
        asyncio.run(GeminiAdapter(client=client).complete(model="m", system=None, prompt="hi"))
    assert len(models.calls) == 1


def test_the_real_client_is_built_with_sdk_retries_off() -> None:
    adapter = GeminiAdapter(api_key="test-key")
    opts = adapter._client._api_client._http_options
    assert opts.retry_options is not None and opts.retry_options.attempts == 1


def test_output_budget_adds_thinking_room_only_on_thinking_models() -> None:
    from writer_engine.llm.gemini_client import output_budget

    assert output_budget("gemini-2.5-pro", 8192) == 8192 + 8192
    assert output_budget("gemini-2.5-pro", 64000) == 65536
    assert output_budget("gemini-2.0-flash", 1000) == 1000
