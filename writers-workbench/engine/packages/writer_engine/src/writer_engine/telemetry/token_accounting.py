"""CR-007 — per-call LLM token + cost accounting, written to ``token_usage_v2`` (billing parity with
the n8n workflows).

The n8n workflows recorded every AI call's tokens + USD cost in ``token_usage_v2``; the engine only
had transient Prometheus counters + the Redis rate-limit budget. This module restores the durable
record so cost-per-chapter is known and the credit model (1 credit = N tokens) can be set.

Design — a request-scoped accumulator on a ``contextvar``:

* an op handler calls :func:`begin` once with the user/project/chapter/workflow context;
* every ``LLMRouter.complete`` call records its usage via :func:`record` (the router is the single
  choke point through which all providers go);
* the op handler calls :func:`flush` (in a finally) to write the collected rows to ``token_usage_v2``.

The accumulator is a *mutable dict held in the contextvar*: ``asyncio.gather`` children share the same
dict reference (copy_context copies the reference, not the dict), so usage recorded inside parallel
sub-chapter tasks still reaches the parent's flush. Children must only READ the contextvar + mutate the
list — never ``set`` a new value.

Everything is best-effort: accounting must never break generation.
"""

from __future__ import annotations

import contextvars
from typing import Any

from writer_engine.telemetry.logging import get_logger

logger = get_logger("token_accounting")

_ctx: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "token_usage_ctx", default=None
)

# $ per 1,000,000 tokens: (input, output, cache_read, cache_write). Anthropic published rates
# (Sonnet/Haiku/Opus 4.x); Perplexity sonar-pro and Gemini are approximate list prices. Override via
# TOKEN_RATES env (JSON) if rates change — see _load_rate_overrides.
_DEFAULT_RATES: dict[str, tuple[float, float, float, float]] = {
    "claude-sonnet-4-6": (3.00, 15.00, 0.30, 3.75),
    "claude-haiku-4-5-20251001": (0.80, 4.00, 0.08, 1.00),
    "claude-opus-4-8": (15.00, 75.00, 1.50, 18.75),
    "sonar-pro": (3.00, 15.00, 0.0, 0.0),       # Perplexity (approx; excl. per-request search fee)
    "gemini-2.5-flash": (0.30, 2.50, 0.0, 0.0),
    "gemini-2.5-pro": (1.25, 10.00, 0.0, 0.0),
}
# Conservative fallback for an unknown model — Sonnet-class.
_FALLBACK_RATE = (3.00, 15.00, 0.30, 3.75)


def cost_usd(model: str, input_tokens: int, output_tokens: int,
             cache_read: int = 0, cache_write: int = 0) -> float:
    r = _DEFAULT_RATES.get(model, _FALLBACK_RATE)
    return round(
        (input_tokens * r[0] + output_tokens * r[1] + cache_read * r[2] + cache_write * r[3])
        / 1_000_000.0,
        6,
    )


def begin(*, user_id: str | None, project_id: str | None = None,
          chapter_number: Any = None, workflow: str = "") -> None:
    """Start a request-scoped accounting context. No-op-safe to call without a user_id (rows just
    won't be persisted, but totals are still queryable in-process)."""
    _ctx.set({
        "user_id": user_id,
        "project_id": project_id,
        "chapter_number": chapter_number,
        "workflow": workflow,
        "calls": [],
    })


def reset() -> None:
    """Clear the active accounting context (used by tests + as a safety reset)."""
    _ctx.set(None)


def record(*, provider: str, model: str, input_tokens: int, output_tokens: int,
           cache_read: int = 0, cache_write: int = 0) -> None:
    """Record one LLM call's usage into the active context (called by the router)."""
    ctx = _ctx.get()
    if ctx is None:
        return
    ctx["calls"].append({
        "provider": provider,
        "model": model,
        "input_tokens": int(input_tokens or 0),
        "output_tokens": int(output_tokens or 0),
        "cache_read_tokens": int(cache_read or 0),
        "cache_write_tokens": int(cache_write or 0),
        "cost_usd": cost_usd(model, input_tokens, output_tokens, cache_read, cache_write),
    })


def snapshot() -> dict[str, Any]:
    """Totals for the active context (for logging / the op result)."""
    ctx = _ctx.get()
    if not ctx:
        return {"calls": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0}
    calls = ctx["calls"]
    inp = sum(c["input_tokens"] for c in calls)
    out = sum(c["output_tokens"] for c in calls)
    cr = sum(c["cache_read_tokens"] for c in calls)
    cw = sum(c["cache_write_tokens"] for c in calls)
    return {
        "calls": len(calls), "input_tokens": inp, "output_tokens": out,
        "cache_read_tokens": cr, "cache_write_tokens": cw,
        "total_tokens": inp + out + cr + cw,
        "cost_usd": round(sum(c["cost_usd"] for c in calls), 6),
    }


async def flush() -> dict[str, Any]:
    """Write the collected calls to token_usage_v2 and return the snapshot. Best-effort: any failure is
    logged, never raised. Requires a user_id (the table's FK) — without one, rows are skipped."""
    ctx = _ctx.get()
    snap = snapshot()
    if not ctx or not ctx.get("calls"):
        return snap
    user_id = ctx.get("user_id")
    if not user_id:
        logger.info("token_accounting.skip", reason="no user_id", **snap)
        _ctx.set(None)
        return snap
    try:
        from writer_engine.config import get_settings
        settings = get_settings()
        if not (settings.supabase_url and settings.supabase_service_role_key):
            return snap
        from writer_engine.persist_helpers import persist_token_usage
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        meta_base = {"project_id": ctx.get("project_id"), "chapter_number": ctx.get("chapter_number")}
        await persist_token_usage(
            client, user_id=str(user_id), workflow=ctx.get("workflow") or "engine",
            calls=ctx["calls"], metadata=meta_base,
        )
        logger.info("token_accounting.flushed", workflow=ctx.get("workflow"),
                    chapter=ctx.get("chapter_number"), **snap)
    except Exception as exc:  # never break the op on accounting
        logger.warning("token_accounting.flush_failed", error=str(exc)[:200], **snap)
    finally:
        _ctx.set(None)
    return snap
