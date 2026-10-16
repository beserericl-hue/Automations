"""Retry a provider call that was rate-limited or briefly unavailable (B8).

A budget stops us from *causing* 429s. It does not stop us from *receiving* them: the window is
shared with anything else using the same account, the caps are conservative guesses rather than the
providers' real ceilings, and a provider may be having a bad minute for reasons that have nothing to
do with us. So the gate needs a partner.

Where this was missing before B8:

    anthropic   AsyncAnthropic(max_retries=5)      retries, honours Retry-After
    openai      AsyncOpenAI (SDK default 2)        retries
    gemini      genai.generate_content             NO retry at all
    perplexity  httpx + raise_for_status           NO retry at all
    firecrawl   httpx                              NO retry at all
    kieai       httpx                              NO retry at all

gemini carries every hub turn (voice and chat) and perplexity is the whole of ``research.run``, so a
single 429 anywhere in that fan-out failed a user's request outright.

The behaviour is deliberately plain: retry only what is worth retrying (429 and 5xx), honour
``Retry-After`` when the provider sends one, back off exponentially with jitter otherwise, and give
up quickly enough that an interactive job still fits its queue's ceiling. Jitter matters more than
usual here because the thing being retried is a fan-out: 8 sub-chapter calls that all 429 and all
sleep exactly 1s will all retry in the same instant and 429 again.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

import httpx

from writer_engine.telemetry.logging import get_logger

logger = get_logger("rate_limit.retry")

T = TypeVar("T")

DEFAULT_ATTEMPTS = 4
DEFAULT_BASE_DELAY_S = 1.0
# A ceiling on one sleep, so a provider's "Retry-After: 300" cannot silently consume an interactive
# job's whole 600s budget in a single wait.
MAX_DELAY_S = 30.0


def status_of(exc: BaseException) -> int | None:
    """The HTTP status an exception carries, across the shapes our clients raise.

    httpx puts it on ``exc.response.status_code``; the Google SDK raises its own exception types that
    carry ``code`` or ``status_code``. Anything unrecognised returns None and is not retried.
    """
    response = getattr(exc, "response", None)
    code = getattr(response, "status_code", None)
    if isinstance(code, int):
        return code
    for attr in ("status_code", "code"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value
    return None


def retry_after_of(exc: BaseException) -> float | None:
    """The provider's own ``Retry-After``, in seconds, when it sent one."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    try:
        raw = headers.get("retry-after") or headers.get("Retry-After")
    except Exception:
        return None
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        # The header may also be an HTTP date. Not worth parsing: fall back to the backoff schedule.
        return None


# Transport-level failures worth another attempt. Matched by TYPE rather than by class name: the
# first version of this matched name suffixes and silently failed to retry `httpx.ReadTimeout`,
# whose name does not end in "TimeoutException" — caught by its own test, which is the only reason
# it is not still broken. Deliberately NOT httpx.TransportError wholesale: that also covers
# UnsupportedProtocol and ProxyError, which are configuration mistakes and will fail identically
# four times over.
_TRANSIENT: tuple[type[BaseException], ...] = (
    TimeoutError,  # builtin; asyncio.TimeoutError is an alias of it on 3.11+
    ConnectionError,  # builtin; ConnectionReset / ConnectionAborted
    httpx.TimeoutException,  # Connect/Read/Write/Pool timeouts
    httpx.NetworkError,  # ConnectError / ReadError / WriteError / CloseError
    httpx.RemoteProtocolError,  # server closed the connection mid-response
)


def is_retryable(exc: BaseException) -> bool:
    """429 and 5xx are worth another attempt. A 4xx is our bug and will fail identically."""
    status = status_of(exc)
    if status is None:
        return isinstance(exc, _TRANSIENT)
    if status == 429:
        return True
    return 500 <= status < 600


def delay_for(attempt: int, exc: BaseException, *, base: float = DEFAULT_BASE_DELAY_S) -> float:
    """How long to wait before attempt ``attempt`` (1-based, so the first retry is attempt 2)."""
    provider_says = retry_after_of(exc)
    if provider_says is not None:
        # Still jittered: without it, a fan-out that all received the same Retry-After retries in
        # lockstep and collides again.
        return min(MAX_DELAY_S, provider_says + random.uniform(0, 0.5))
    backoff = base * (2 ** max(0, attempt - 1))
    return min(MAX_DELAY_S, backoff * random.uniform(0.5, 1.5))


async def with_retry(
    func: Callable[[], Awaitable[T]],
    *,
    provider: str,
    model: str = "",
    attempts: int = DEFAULT_ATTEMPTS,
    base_delay_s: float = DEFAULT_BASE_DELAY_S,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> T:
    """Call ``func``, retrying a 429/5xx up to ``attempts`` times total.

    Re-raises the last exception when the attempts run out, so the caller sees the real provider
    error rather than a wrapper that hides it.
    """
    last: BaseException | None = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            return await func()
        except Exception as exc:
            last = exc
            if attempt >= attempts or not is_retryable(exc):
                raise
            wait = delay_for(attempt, exc, base=base_delay_s)
            logger.warning(
                "provider.retry",
                provider=provider,
                model=model or None,
                attempt=attempt,
                of=attempts,
                status=status_of(exc),
                wait_s=round(wait, 2),
                error=f"{type(exc).__name__}: {str(exc)[:160]}",
            )
            await sleep(wait)
    raise last if last is not None else RuntimeError("with_retry: no attempt was made")


__all__ = [
    "DEFAULT_ATTEMPTS",
    "MAX_DELAY_S",
    "delay_for",
    "is_retryable",
    "retry_after_of",
    "status_of",
    "with_retry",
]
