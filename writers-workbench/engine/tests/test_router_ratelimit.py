"""CR-003 scaling: the router enforces the budget + per-instance concurrency on every LLM call."""

from __future__ import annotations

import asyncio

from writer_engine.llm.router import LLMResponse, LLMRouter


class _Adapter:
    provider = "anthropic"

    def __init__(self) -> None:
        self.live = 0
        self.max_live = 0

    async def complete(self, **kw) -> LLMResponse:
        self.live += 1
        self.max_live = max(self.max_live, self.live)
        await asyncio.sleep(0.02)
        self.live -= 1
        return LLMResponse(text="ok", input_tokens=10, output_tokens=20, model=kw["model"], provider="anthropic")


class _Budget:
    def __init__(self) -> None:
        self.waited = []
        self.recorded = []

    async def wait_for_capacity(self, *, model, input_tokens, output_tokens, max_wait_s):
        self.waited.append((model, input_tokens, output_tokens))

    async def record_usage(self, *, model, input_tokens, output_tokens):
        self.recorded.append((model, input_tokens, output_tokens))


def test_router_calls_budget_before_and_after() -> None:
    b = _Budget()
    r = LLMRouter(budget=b, max_concurrent=4)
    r.register(_Adapter())
    asyncio.run(r.complete(provider="anthropic", model="claude-sonnet-4-6", prompt="x" * 400, max_tokens=3000))
    assert b.waited and b.waited[0][0] == "claude-sonnet-4-6"
    assert b.waited[0][1] == 100  # ~400 chars / 4 = 100 est input tokens
    assert b.recorded == [("claude-sonnet-4-6", 10, 20)]  # actual usage recorded


def test_router_caps_concurrency_per_instance() -> None:
    adapter = _Adapter()
    r = LLMRouter(max_concurrent=3)
    r.register(adapter)

    async def go():
        await asyncio.gather(*[
            r.complete(provider="anthropic", model="m", prompt="p", max_tokens=10) for _ in range(20)
        ])

    asyncio.run(go())
    assert adapter.max_live <= 3  # never more than the per-instance cap in flight


def test_router_without_limits_is_plain_dispatch() -> None:
    r = LLMRouter()
    r.register(_Adapter())
    out = asyncio.run(r.complete(provider="anthropic", model="m", prompt="p", max_tokens=10))
    assert out.text == "ok"
