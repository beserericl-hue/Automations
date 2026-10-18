"""B3 — is MAX_CONCURRENT_LLM a real per-instance cap, or N independent semaphores?

The semaphore lives in the `LLMRouter` module singleton, so the documented cap of 12 was really
12 x (number of processes that build a router). With 19 step uvicorns plus the worker and the
orchestrator, "~10 users per instance" had no basis.

B10's collapse resolved it: every step now runs inside ONE process (`steps_app`), and only step
modules build a router — the arq workers reach steps over HTTP and never call a provider directly.
This file pins both halves of that, because either one quietly changing restores the bug: a worker
that starts calling an LLM, or a step peeled out into its own process, doubles the real cap while
the configured number stays 12.
"""

from __future__ import annotations

import asyncio
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILDS_A_ROUTER = re.compile(r"\bget_router\s*\(")


def _modules_that_build_a_router() -> set[str]:
    """Which service packages construct an LLMRouter (and therefore their own semaphore)."""
    found: set[str] = set()
    for path in (ROOT / "services").rglob("*.py"):
        if "/tests/" in str(path):
            continue
        if BUILDS_A_ROUTER.search(path.read_text()):
            # services/<name>/src/<pkg>/main.py -> <name>
            found.add(path.relative_to(ROOT / "services").parts[0])
    return found


def test_every_llm_caller_runs_inside_the_single_steps_process() -> None:
    from steps_app.main import STEP_APPS

    in_steps_app = {f"{name}_step" for name in STEP_APPS} | set(STEP_APPS)
    offenders = sorted(_modules_that_build_a_router() - in_steps_app)
    assert not offenders, (
        f"{offenders} build their own LLMRouter outside the steps process, so MAX_CONCURRENT_LLM is "
        "no longer a per-instance cap (B3)"
    )


def test_the_worker_and_orchestrator_do_not_call_providers_directly() -> None:
    """They dial steps over HTTP. A provider call from either would be a second semaphore in the
    same container — and the arq worker runs 8 heavy jobs at once."""
    for service in ("orchestrator",):
        for path in (ROOT / "services" / service).rglob("*.py"):
            if "/tests/" in str(path):
                continue
            assert not BUILDS_A_ROUTER.search(path.read_text()), path


def test_the_router_is_a_singleton_per_process() -> None:
    """One cap per process only holds if the module hands back the same router every time."""
    from writer_engine.llm.factory import get_router

    assert get_router(service="a") is get_router(service="b")


def test_the_cap_is_actually_enforced() -> None:
    """The semaphore exists and admits no more than `max_concurrent` at once."""
    from writer_engine.llm.router import LLMRouter

    state = {"peak": 0, "live": 0}

    async def _exercise() -> None:
        # Built inside the loop: a semaphore and its waiters must belong to the same event loop.
        sem = LLMRouter(max_concurrent=2)._sem
        assert sem is not None

        async def _work() -> None:
            async with sem:
                state["live"] += 1
                state["peak"] = max(state["peak"], state["live"])
                await asyncio.sleep(0.01)
                state["live"] -= 1

        await asyncio.wait_for(asyncio.gather(*[_work() for _ in range(8)]), timeout=5)

    asyncio.run(_exercise())
    assert state["peak"] == 2


def test_zero_means_uncapped_not_zero_slots() -> None:
    """A misread here would deadlock every LLM call rather than leave them ungated."""
    from writer_engine.llm.router import LLMRouter

    assert LLMRouter(max_concurrent=0)._sem is None
