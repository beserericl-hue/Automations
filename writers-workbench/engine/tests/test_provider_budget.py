"""B8 — every provider is rate-gated and every provider retries a 429.

Before this, exactly one of six providers had either. The gaps that mattered most:

* ``gemini`` carries every hub turn (voice and chat) and had no retry at all;
* ``perplexity`` is the whole of ``research.run`` and had no retry at all;
* nothing but Anthropic had a budget, so N instances x 32 jobs each could aim an unbounded request
  rate at one account-wide per-minute limit.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from writer_engine.rate_limit import retry as retry_mod
from writer_engine.rate_limit.provider_budget import (
    DEFAULT_PROVIDER_LIMITS,
    EXCLUDED_PROVIDERS,
    LLMBudget,
    ProviderBudget,
    ProviderLimits,
    call_provider,
    effective_limits,
    parse_overrides,
)

# --- limits + configuration ---------------------------------------------------------------------


def test_every_provider_the_engine_actually_calls_has_a_limit() -> None:
    """A provider missing here is a provider with no gate — which is where B8 started."""
    assert set(DEFAULT_PROVIDER_LIMITS) == {
        "gemini",
        "perplexity",
        "openai",
        "firecrawl",
        "kieai",
        "stealthgpt",
    }


def test_anthropic_is_excluded_on_purpose() -> None:
    """It has a per-MODEL token budget; gating it on account RPM as well would double-count."""
    assert "anthropic" in EXCLUDED_PROVIDERS
    assert "anthropic" not in DEFAULT_PROVIDER_LIMITS
    assert ProviderBudget(limits=DEFAULT_PROVIDER_LIMITS).limits_for("anthropic").rpm == 0


def test_an_unknown_provider_is_not_gated() -> None:
    """A name we do not know is far more likely a typo than a provider to invent limits for."""
    budget = ProviderBudget(limits=DEFAULT_PROVIDER_LIMITS)
    assert budget.limits_for("some-new-thing").rpm == 0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("gemini=600", {"gemini": ProviderLimits(rpm=600)}),
        ("openai=500/2000000", {"openai": ProviderLimits(rpm=500, tpm=2_000_000)}),
        (" perplexity = 30 , kieai=5 ", {"perplexity": ProviderLimits(30), "kieai": ProviderLimits(5)}),
        ("", {}),
    ],
)
def test_overrides_parse(raw: str, expected: dict[str, ProviderLimits]) -> None:
    assert parse_overrides(raw) == expected


def test_a_malformed_override_is_skipped_not_fatal() -> None:
    """A typo in an env var must not stop the engine from starting."""
    assert parse_overrides("gemini=notanumber,perplexity=30") == {"perplexity": ProviderLimits(30)}
    assert parse_overrides("=50") == {}


def test_overrides_may_raise_lower_or_introduce_a_provider() -> None:
    merged = effective_limits("perplexity=5,brand-new=10")
    assert merged["perplexity"] == ProviderLimits(5)
    assert merged["brand-new"] == ProviderLimits(10)
    assert merged["gemini"] == DEFAULT_PROVIDER_LIMITS["gemini"]  # untouched


# --- the gate ----------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_calls_are_counted_against_the_window(fake_redis: Any) -> None:
    budget = ProviderBudget(redis_client=fake_redis, limits={"gemini": ProviderLimits(rpm=10)})
    for _ in range(3):
        await budget.record_usage(provider="gemini", model="gemini-2.5-flash")
    assert (await budget.snapshot("gemini", "gemini-2.5-flash"))["requests"] == 3


@pytest.mark.asyncio
async def test_the_window_is_per_model(fake_redis: Any) -> None:
    """flash and pro have different ceilings in every published tier."""
    budget = ProviderBudget(redis_client=fake_redis, limits={"gemini": ProviderLimits(rpm=10)})
    await budget.record_usage(provider="gemini", model="gemini-2.5-flash")
    assert (await budget.snapshot("gemini", "gemini-2.5-pro"))["requests"] == 0


@pytest.mark.asyncio
async def test_capacity_is_granted_under_the_limit(fake_redis: Any) -> None:
    budget = ProviderBudget(redis_client=fake_redis, limits={"perplexity": ProviderLimits(rpm=2)})
    assert await budget.wait_for_capacity(provider="perplexity", model="sonar", max_wait_s=0.0)


@pytest.mark.asyncio
async def test_capacity_is_refused_once_the_window_is_full(fake_redis: Any) -> None:
    """Refused, not raised: the caller's next move is the same either way."""
    budget = ProviderBudget(redis_client=fake_redis, limits={"perplexity": ProviderLimits(rpm=2)})
    for _ in range(2):
        await budget.record_usage(provider="perplexity", model="sonar")
    assert await budget.wait_for_capacity(provider="perplexity", model="sonar", max_wait_s=0.0) is False


@pytest.mark.asyncio
async def test_tokens_gate_too_when_a_tpm_is_set(fake_redis: Any) -> None:
    budget = ProviderBudget(redis_client=fake_redis, limits={"openai": ProviderLimits(rpm=1000, tpm=100)})
    await budget.record_usage(provider="openai", model="emb", input_tokens=90)
    assert (
        await budget.wait_for_capacity(provider="openai", model="emb", input_tokens=50, max_wait_s=0.0)
        is False
    )
    assert await budget.wait_for_capacity(provider="openai", model="emb", input_tokens=5, max_wait_s=0.0)


@pytest.mark.asyncio
async def test_an_ungated_provider_skips_redis_entirely() -> None:
    """No limits configured must mean no Redis dependency — not an unreachable-Redis failure."""
    budget = ProviderBudget(redis_client=None, limits={})
    assert await budget.wait_for_capacity(provider="whatever", model="m", max_wait_s=0.0)
    await budget.record_usage(provider="whatever", model="m")  # must not raise


@pytest.mark.asyncio
async def test_the_gate_fails_open_when_the_client_cannot_be_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rate gate that fails closed takes the engine down harder than the 429s it prevents."""

    async def _boom() -> Any:
        raise ConnectionError("redis down")

    monkeypatch.setattr("writer_engine.redis_client.client.get_redis", _boom)
    budget = ProviderBudget(limits={"gemini": ProviderLimits(rpm=1)})
    assert await budget.wait_for_capacity(provider="gemini", model="m", max_wait_s=0.0)


class _CommandsFail:
    """A client that is built fine and fails on every COMMAND.

    This is what an unreachable Redis actually looks like: redis-py connects lazily, so nothing
    fails until the first command. The test above — faking a failing ``get_redis`` — only covered
    acquisition, and the gate RAISED on the command path. Found by running the real canon-retrieval
    path on a machine with no Redis, where the ConnectionError came out through call_provider into
    embeddings.
    """

    def __getattr__(self, _name: str) -> Any:
        async def _fail(*_a: Any, **_k: Any) -> Any:
            raise ConnectionError("Connect call failed")

        return _fail


@pytest.mark.asyncio
async def test_the_gate_fails_open_when_commands_fail() -> None:
    budget = ProviderBudget(
        redis_client=_CommandsFail(),  # type: ignore[arg-type]
        limits={"gemini": ProviderLimits(rpm=1, tpm=10)},
    )
    assert await budget.wait_for_capacity(provider="gemini", model="m", max_wait_s=0.0) is True
    await budget.record_usage(provider="gemini", model="m", input_tokens=5)  # must not raise
    assert await budget.snapshot("gemini", "m") == {"requests": 0, "tokens": 0}


@pytest.mark.asyncio
async def test_call_provider_still_calls_through_when_redis_commands_fail() -> None:
    """The path that actually broke: embeddings / firecrawl / kieai go through call_provider, which
    has no router above it to contain a raise."""
    budget = ProviderBudget(
        redis_client=_CommandsFail(),  # type: ignore[arg-type]
        limits={"openai": ProviderLimits(rpm=1, tpm=10)},
    )
    calls: list[int] = []

    async def _work() -> str:
        calls.append(1)
        return "embedded"

    out = await call_provider("openai", _work, model="emb", input_tokens=9999, budget=budget)
    assert out == "embedded"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_the_anthropic_budget_also_fails_open_on_command_errors() -> None:
    """Same lazy-connection trap; the router contains a raise there, snapshot() does not."""
    from writer_engine.rate_limit import AnthropicBudget

    budget = AnthropicBudget(redis_client=_CommandsFail())  # type: ignore[arg-type]
    await budget.wait_for_capacity(
        model="claude-sonnet-4-6", input_tokens=10, output_tokens=10, max_wait_s=0.0
    )
    await budget.record_usage(model="claude-sonnet-4-6", input_tokens=1, output_tokens=1)
    assert await budget.snapshot("claude-sonnet-4-6") == {
        "input_tokens": 0,
        "output_tokens": 0,
        "requests": 0,
    }


# --- the facade the router uses ----------------------------------------------------------------


class _Recorder:
    def __init__(self) -> None:
        self.waited: list[Any] = []
        self.recorded: list[Any] = []

    async def wait_for_capacity(self, **kw: Any) -> Any:
        self.waited.append(kw)
        return True

    async def record_usage(self, **kw: Any) -> None:
        self.recorded.append(kw)


@pytest.mark.asyncio
async def test_anthropic_goes_to_the_token_budget_and_others_to_the_request_budget() -> None:
    anthropic, providers = _Recorder(), _Recorder()
    budget = LLMBudget(anthropic=anthropic, providers=providers)

    await budget.wait_for_capacity(
        provider="anthropic", model="claude-sonnet-4-6", input_tokens=10, output_tokens=20
    )
    await budget.wait_for_capacity(
        provider="gemini", model="gemini-2.5-flash", input_tokens=1, output_tokens=2
    )

    assert len(anthropic.waited) == 1 and len(providers.waited) == 1
    # The Anthropic budget predates B8 and does NOT take a provider argument.
    assert "provider" not in anthropic.waited[0]
    assert providers.waited[0]["provider"] == "gemini"


@pytest.mark.asyncio
async def test_the_facade_is_safe_with_either_half_missing() -> None:
    budget = LLMBudget()
    await budget.wait_for_capacity(provider="gemini", model="m", input_tokens=0, output_tokens=0)
    await budget.record_usage(provider="gemini", model="m", input_tokens=0, output_tokens=0)


@pytest.mark.asyncio
async def test_the_router_gates_every_provider_not_just_anthropic() -> None:
    """The actual B8 change at the choke point: the branch used to be `if provider == "anthropic"`."""
    from writer_engine.llm.router import LLMResponse, LLMRouter

    class _Budget:
        def __init__(self) -> None:
            self.providers: list[str] = []

        async def wait_for_capacity(self, *, provider: str, **_: Any) -> None:
            self.providers.append(provider)

        async def record_usage(self, **_: Any) -> None:
            pass

    class _Adapter:
        def __init__(self, provider: str) -> None:
            self.provider = provider

        async def complete(self, **kw: Any) -> LLMResponse:
            return LLMResponse(
                text="x", input_tokens=1, output_tokens=1, model=kw["model"], provider=self.provider
            )

    gate = _Budget()
    router = LLMRouter(budget=gate)
    for name in ("anthropic", "gemini", "perplexity"):
        router.register(_Adapter(name))
        await router.complete(provider=name, model="m", prompt="p", max_tokens=10)
    assert gate.providers == ["anthropic", "gemini", "perplexity"]


# --- retry ------------------------------------------------------------------------------------


def _http_error(status: int, retry_after: str | None = None) -> httpx.HTTPStatusError:
    headers = {"retry-after": retry_after} if retry_after else {}
    request = httpx.Request("POST", "https://example.test")
    response = httpx.Response(status, headers=headers, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


@pytest.mark.parametrize("status", [429, 500, 502, 503, 529])
def test_rate_limits_and_server_errors_are_retryable(status: int) -> None:
    assert retry_mod.is_retryable(_http_error(status))


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_client_errors_are_not_retried(status: int) -> None:
    """A 401 will fail identically four times; retrying it only delays the real error."""
    assert not retry_mod.is_retryable(_http_error(status))


def test_a_transport_timeout_is_retryable_but_a_bug_is_not() -> None:
    assert retry_mod.is_retryable(httpx.ReadTimeout("slow"))
    assert retry_mod.is_retryable(httpx.ConnectError("no route"))
    assert not retry_mod.is_retryable(ValueError("my own mistake"))


def test_a_status_on_the_exception_itself_is_found() -> None:
    """The Google SDK raises its own types, which carry `code` rather than a response."""

    class _Googleish(Exception):
        code = 429

    assert retry_mod.status_of(_Googleish()) == 429
    assert retry_mod.is_retryable(_Googleish())


def test_retry_after_is_honoured_and_capped() -> None:
    assert retry_mod.retry_after_of(_http_error(429, "7")) == 7.0
    # A provider asking for 10 minutes must not consume an interactive job's whole budget.
    assert retry_mod.delay_for(1, _http_error(429, "600")) <= retry_mod.MAX_DELAY_S


def test_an_http_date_retry_after_falls_back_to_backoff() -> None:
    assert retry_mod.retry_after_of(_http_error(429, "Wed, 21 Oct 2026 07:28:00 GMT")) is None


def test_backoff_is_jittered() -> None:
    """A fan-out that all sleep the same amount retries in lockstep and collides again."""
    delays = {retry_mod.delay_for(2, _http_error(500)) for _ in range(20)}
    assert len(delays) > 1


def test_backoff_grows_with_the_attempt() -> None:
    early = [retry_mod.delay_for(1, _http_error(500)) for _ in range(30)]
    later = [retry_mod.delay_for(3, _http_error(500)) for _ in range(30)]
    assert max(early) < max(later)


@pytest.mark.asyncio
async def test_with_retry_eventually_succeeds() -> None:
    slept: list[float] = []
    attempts = {"n": 0}

    async def _flaky() -> str:
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise _http_error(429)
        return "ok"

    async def _sleep(d: float) -> None:
        slept.append(d)

    out = await retry_mod.with_retry(_flaky, provider="perplexity", sleep=_sleep)
    assert out == "ok"
    assert attempts["n"] == 3
    assert len(slept) == 2


@pytest.mark.asyncio
async def test_with_retry_reraises_the_real_error_when_attempts_run_out() -> None:
    """The caller must see the provider's error, not a wrapper that hides which provider failed."""

    async def _always_429() -> str:
        raise _http_error(429)

    async def _sleep(_d: float) -> None:
        return None

    with pytest.raises(httpx.HTTPStatusError) as caught:
        await retry_mod.with_retry(_always_429, provider="gemini", attempts=3, sleep=_sleep)
    assert caught.value.response.status_code == 429


@pytest.mark.asyncio
async def test_with_retry_does_not_sleep_on_a_non_retryable_error() -> None:
    slept: list[float] = []

    async def _bad_request() -> str:
        raise _http_error(400)

    async def _sleep(d: float) -> None:
        slept.append(d)

    with pytest.raises(httpx.HTTPStatusError):
        await retry_mod.with_retry(_bad_request, provider="firecrawl", sleep=_sleep)
    assert slept == []


# --- call_provider ------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_provider_counts_exactly_one_request(fake_redis: Any) -> None:
    """Token counts go through this call, because record_usage always counts a request as well —
    recording tokens separately would count the request twice and halve the effective RPM."""
    budget = ProviderBudget(redis_client=fake_redis, limits={"openai": ProviderLimits(rpm=10, tpm=1000)})

    async def _work() -> str:
        return "done"

    out = await call_provider("openai", _work, model="emb", input_tokens=40, budget=budget)
    assert out == "done"
    snap = await budget.snapshot("openai", "emb")
    assert snap["requests"] == 1
    assert snap["tokens"] == 40


@pytest.mark.asyncio
async def test_a_failed_call_is_still_counted(fake_redis: Any) -> None:
    """The provider counted it. A failure that goes unrecorded makes the window under-report."""
    budget = ProviderBudget(redis_client=fake_redis, limits={"firecrawl": ProviderLimits(rpm=10)})

    async def _work() -> str:
        raise _http_error(400)

    with pytest.raises(httpx.HTTPStatusError):
        await call_provider("firecrawl", _work, budget=budget)
    assert (await budget.snapshot("firecrawl", ""))["requests"] == 1
