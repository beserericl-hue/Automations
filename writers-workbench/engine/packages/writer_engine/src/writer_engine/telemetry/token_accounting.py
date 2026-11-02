"""Exact per-call cost accounting, written to ``token_usage_v2`` (CR-007, extended by migration 043).

Every paid provider call — LLM tokens (Anthropic, Gemini, Perplexity), embeddings (OpenAI), images
(KIE, DALL-E), humanizer words (StealthGPT), scraper credits (ScraperAPI) — becomes ONE row labelled
with the operation (``<step>.<op>``), user, project, chapter/content, run id, the units it used, the
prices it was costed at (:mod:`writer_engine.telemetry.pricing`) and whether the dollars are
provider-reported, computed, estimated or unpriced.

Design — a request-scoped accumulator on a ``contextvar``:

* the step template (or any other entry point: the hub, cron jobs) calls :func:`begin` with the
  user/project/chapter/operation context;
* every paid call records itself: ``LLMRouter.complete`` for all LLM providers, and
  :func:`record_units` from the embedding / image / humanize / scrape call sites;
* rows are written AS THEY ARE RECORDED, by a background task, not only at the end. A job killed by
  a deploy or a worker timeout used to lose every row it had accumulated (22 Q/A jobs on DEV);
* :func:`flush` (called in a ``finally``) writes whatever is still pending inside
  ``asyncio.shield`` so a cancellation cannot stop the write, then clears the context.

The accumulator is a *mutable dict held in the contextvar*: ``asyncio.gather`` children share the same
dict reference (copy_context copies the reference, not the dict), so usage recorded inside parallel
sub-chapter tasks still reaches the parent. Children must only READ the contextvar + mutate the
lists — never ``set`` a new value.

A call recorded with NO context is still written (operation ``unattributed.<provider>``, no user):
money spent outside a labelled op must show up as unlabelled, not vanish.

Everything is best-effort: accounting must never break generation.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
from collections.abc import AsyncIterator
from typing import Any

from writer_engine.telemetry import pricing
from writer_engine.telemetry.logging import get_logger

logger = get_logger("token_accounting")

_ctx: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar("token_usage_ctx", default=None)

# Strong references to in-flight write tasks: the event loop only keeps weak ones, and a write that
# is garbage-collected mid-flight is a lost billing row.
_BACKGROUND: set[asyncio.Task[Any]] = set()


def _new_ctx(
    *,
    user_id: str | None,
    project_id: str | None,
    chapter_number: Any,
    workflow: str,
    run_id: str | None = None,
    content_id: str | None = None,
) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "project_id": project_id,
        "chapter_number": chapter_number,
        "content_id": content_id,
        "run_id": run_id,
        "workflow": workflow,
        "calls": [],
        "pending": [],
        "drain": None,
    }


# Rows recorded with no active context collect here and are written the same way.
_ORPHAN: dict[str, Any] = _new_ctx(user_id=None, project_id=None, chapter_number=None, workflow="")


def cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read: int = 0,
    cache_write: int = 0,
    *,
    provider: str = "anthropic",
) -> float:
    """Back-compat helper: dollars for an Anthropic-shaped call (0.0 when the model is unpriced)."""
    return pricing.token_cost(
        provider,
        model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read=cache_read,
        cache_write_5m=cache_write,
    ).cost_usd


def begin(
    *,
    user_id: str | None,
    project_id: str | None = None,
    chapter_number: Any = None,
    workflow: str = "",
    run_id: str | None = None,
    content_id: str | None = None,
) -> None:
    """Start a request-scoped accounting context."""
    _ctx.set(
        _new_ctx(
            user_id=user_id,
            project_id=project_id,
            chapter_number=chapter_number,
            workflow=workflow,
            run_id=run_id,
            content_id=content_id,
        )
    )


def reset() -> None:
    """Clear the active accounting context (used by tests + as a safety reset)."""
    _ctx.set(None)


def _chapter(value: Any) -> int | None:
    try:
        return int(value) if value is not None and str(value).strip() != "" else None
    except (TypeError, ValueError):
        return None


def _row(ctx: dict[str, Any], call: dict[str, Any], operation: str | None) -> dict[str, Any]:
    op = operation or ctx.get("workflow") or f"unattributed.{call['provider']}"
    inp, out = call["input_tokens"], call["output_tokens"]
    cr, cw, cw1h = call["cache_read_tokens"], call["cache_write_tokens"], call["cache_write_1h_tokens"]
    project_id = ctx.get("project_id")
    return {
        "user_id": str(ctx["user_id"]) if ctx.get("user_id") else None,
        "workflow_name": op,
        "operation": op,
        "provider": call["provider"],
        "model": call["model"],
        "input_tokens": inp,
        "output_tokens": out,
        # total includes cache tokens so analytics reflect the full billable token footprint
        "total_tokens": inp + out + cr + cw + cw1h,
        "cache_read_tokens": cr,
        "cache_write_tokens": cw,
        "cache_write_1h_tokens": cw1h,
        "units": call.get("units"),
        "unit_type": call.get("unit_type"),
        "unit_prices": call.get("unit_prices") or {},
        "cost_usd": call["cost_usd"],
        "cost_source": call["cost_source"],
        "source": "engine",
        "project_id": str(project_id) if project_id else None,
        "content_id": call.get("content_id") or ctx.get("content_id"),
        "chapter_number": _chapter(ctx.get("chapter_number")),
        "run_id": ctx.get("run_id"),
        "request_id": call.get("request_id"),
        "metadata": {
            # Kept for readers written before migration 043 (CostDashboard's project filter).
            "provider": call["provider"],
            "project_id": project_id,
            "chapter_number": ctx.get("chapter_number"),
            "cache_read_tokens": cr,
            "cache_write_tokens": cw,
            **(call.get("metadata") or {}),
        },
    }


def _append(call: dict[str, Any], operation: str | None) -> None:
    ctx = _ctx.get()
    target = ctx if ctx is not None else _ORPHAN
    if ctx is not None:
        # The orphan bucket only queues rows for writing; keeping every unattributed call in memory
        # for the life of the process would be a slow leak.
        target["calls"].append(call)
    else:
        logger.info("token_accounting.unattributed", provider=call["provider"], model=call["model"])
    if call["cost_source"] == pricing.COST_UNPRICED:
        # Loud on purpose: an unpriced call is money the cost view cannot show.
        logger.warning("token_accounting.unpriced", provider=call["provider"], model=call["model"])
    if not _persistence_enabled():
        return
    target["pending"].append(_row(target, call, operation))
    _schedule_drain(target)


def record(
    *,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read: int = 0,
    cache_write: int = 0,
    cache_write_1h: int = 0,
    reported_cost_usd: float | None = None,
    request_fee_tier: str | None = None,
    request_id: str | None = None,
    operation: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Record one token-billed call (called by the router for every LLM provider).

    ``input_tokens`` is uncached input; ``cache_write`` is 5-minute cache writes and
    ``cache_write_1h`` 1-hour ones (Anthropic bills them at 1.25x / 2x input).
    """
    try:
        cost = pricing.token_cost(
            provider,
            model,
            input_tokens=int(input_tokens or 0),
            output_tokens=int(output_tokens or 0),
            cache_read=int(cache_read or 0),
            cache_write_5m=int(cache_write or 0),
            cache_write_1h=int(cache_write_1h or 0),
            reported_cost_usd=reported_cost_usd,
            request_fee_tier=request_fee_tier,
        )
        _append(
            {
                "provider": provider,
                "model": model,
                "input_tokens": int(input_tokens or 0),
                "output_tokens": int(output_tokens or 0),
                "cache_read_tokens": int(cache_read or 0),
                "cache_write_tokens": int(cache_write or 0),
                "cache_write_1h_tokens": int(cache_write_1h or 0),
                "units": None,
                "unit_type": None,
                "cost_usd": cost.cost_usd,
                "cost_source": cost.cost_source,
                "unit_prices": cost.unit_prices,
                "request_id": request_id,
                "metadata": metadata,
            },
            operation,
        )
    except Exception as exc:  # accounting must never break a generation
        logger.warning("token_accounting.record_failed", error=f"{type(exc).__name__}: {exc}"[:200])


def record_units(
    *,
    provider: str,
    model: str,
    units: float,
    unit_type: str,
    credits: float | None = None,
    input_tokens: int = 0,
    cost: pricing.Cost | None = None,
    request_id: str | None = None,
    operation: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Record one unit-billed call: words, credits, images, embedding tokens.

    ``credits`` is the provider's own credit count when it reports one. For token-priced non-chat
    calls (embeddings) pass ``input_tokens`` and the token price is used.
    """
    try:
        if cost is None:
            if input_tokens and pricing.price_entry(provider, model) and unit_type == "tokens":
                cost = pricing.token_cost(provider, model, input_tokens=int(input_tokens))
            else:
                cost = pricing.unit_cost(provider, model, units=float(units), credits=credits)
        meta = dict(metadata or {})
        if credits is not None:
            meta.setdefault("credits", credits)
        _append(
            {
                "provider": provider,
                "model": model,
                "input_tokens": int(input_tokens or 0),
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "cache_write_1h_tokens": 0,
                "units": float(units),
                "unit_type": unit_type,
                "cost_usd": cost.cost_usd,
                "cost_source": cost.cost_source,
                "unit_prices": cost.unit_prices,
                "request_id": request_id,
                "metadata": meta,
            },
            operation,
        )
    except Exception as exc:
        logger.warning("token_accounting.record_failed", error=f"{type(exc).__name__}: {exc}"[:200])


def snapshot() -> dict[str, Any]:
    """Totals for the active context (for logging / the op result)."""
    ctx = _ctx.get()
    return _snapshot(ctx)


def _snapshot(ctx: dict[str, Any] | None) -> dict[str, Any]:
    if not ctx:
        return {"calls": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0}
    calls = ctx["calls"]
    inp = sum(c["input_tokens"] for c in calls)
    out = sum(c["output_tokens"] for c in calls)
    cr = sum(c["cache_read_tokens"] for c in calls)
    cw = sum(c["cache_write_tokens"] + c["cache_write_1h_tokens"] for c in calls)
    snap: dict[str, Any] = {
        "calls": len(calls),
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_tokens": cr,
        "cache_write_tokens": cw,
        "total_tokens": inp + out + cr + cw,
        "cost_usd": round(sum(c["cost_usd"] for c in calls), 6),
    }
    unpriced = sum(1 for c in calls if c["cost_source"] == pricing.COST_UNPRICED)
    if unpriced:
        snap["unpriced_calls"] = unpriced
    return snap


# ------------------------------------------------------------------------------------- persistence


def _persistence_enabled() -> bool:
    try:
        from writer_engine.config import get_settings

        s = get_settings()
        return bool(s.supabase_url and s.supabase_service_role_key)
    except Exception:
        return False


async def _write_rows(rows: list[dict[str, Any]]) -> int:
    from writer_engine.persist_helpers import persist_token_usage
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    return await persist_token_usage(client, rows=rows)


async def _drain(ctx: dict[str, Any]) -> None:
    """Write every pending row of ``ctx``. On failure the rows go back on the queue for flush()."""
    while ctx["pending"]:
        batch = list(ctx["pending"])
        ctx["pending"].clear()
        try:
            await _write_rows(batch)
        except Exception as exc:
            ctx["pending"][:0] = batch
            ctx.setdefault("failures", 0)
            ctx["failures"] += 1
            logger.warning("token_accounting.write_failed", rows=len(batch), error=str(exc)[:200])
            return


def _schedule_drain(ctx: dict[str, Any]) -> None:
    current = ctx.get("drain")
    if current is not None and not current.done():
        return  # the running drain loops until the queue is empty
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop: flush() writes it
    task = loop.create_task(_drain(ctx))
    ctx["drain"] = task
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


async def _finish(ctx: dict[str, Any]) -> None:
    current = ctx.get("drain")
    if current is not None and not current.done():
        with contextlib.suppress(BaseException):  # the drain logs its own failures
            await current
    if ctx["pending"]:
        await _drain(ctx)
    if ctx["pending"] and ctx.get("failures", 0) < 3:
        await asyncio.sleep(0.5)
        await _drain(ctx)  # one retry: a transient Supabase blip should not drop billing data
    if ctx["pending"]:
        logger.error("token_accounting.rows_lost", rows=len(ctx["pending"]), workflow=ctx.get("workflow"))


async def flush(*, wait: bool = True) -> dict[str, Any]:
    """Write anything still pending and clear the context; return the snapshot.

    Safe to call from a ``finally`` while the task is being cancelled: the write runs in its own task
    under ``asyncio.shield``, so a cancellation (a worker timeout, a client disconnect, a deploy's
    SIGTERM) stops the WAIT, never the WRITE.
    """
    ctx = _ctx.get()
    _ctx.set(None)
    snap = _snapshot(ctx)
    if not ctx or not ctx.get("calls"):
        return snap
    if not ctx.get("user_id"):
        logger.info("token_accounting.no_user", workflow=ctx.get("workflow"), **snap)
    if _persistence_enabled():
        task = asyncio.ensure_future(_finish(ctx))
        _BACKGROUND.add(task)
        task.add_done_callback(_BACKGROUND.discard)
        if not wait:
            return snap  # latency-sensitive caller (the hub): the write finishes in the background
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            logger.warning("token_accounting.flush_cancelled_write_continues", workflow=ctx.get("workflow"))
            raise
        except Exception as exc:
            logger.warning("token_accounting.flush_failed", error=str(exc)[:200], **snap)
    logger.info(
        "token_accounting.flushed", workflow=ctx.get("workflow"), chapter=ctx.get("chapter_number"), **snap
    )
    return snap


@contextlib.asynccontextmanager
async def scope(
    *,
    workflow: str,
    user_id: str | None = None,
    project_id: str | None = None,
    chapter_number: Any = None,
    run_id: str | None = None,
    content_id: str | None = None,
    wait: bool = True,
) -> AsyncIterator[None]:
    """A labelled accounting context for paid calls made OUTSIDE a step (the hub's Gemini router,
    cron jobs). An enclosing context is restored afterwards; this scope's rows carry its own label.
    The flush runs on every exit, cancellation included."""
    token = _ctx.set(
        _new_ctx(
            user_id=user_id,
            project_id=project_id,
            chapter_number=chapter_number,
            workflow=workflow,
            run_id=run_id,
            content_id=content_id,
        )
    )
    try:
        yield
    finally:
        try:
            await flush(wait=wait)
        finally:
            _ctx.reset(token)


async def drain_orphans() -> None:
    """Write calls recorded outside any context (tests, shutdown hooks)."""
    if _ORPHAN["pending"] and _persistence_enabled():
        await _finish(_ORPHAN)


async def wait_for_writes() -> None:
    """Await every in-flight background write (tests + graceful shutdown)."""
    while _BACKGROUND:
        await asyncio.gather(*list(_BACKGROUND), return_exceptions=True)
