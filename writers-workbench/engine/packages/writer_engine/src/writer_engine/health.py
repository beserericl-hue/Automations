"""Dependency probes for real health/readiness endpoints.

B2 from the remaining-work inventory: the orchestrator's ``/admin/health`` returned
``{"status": "ok"}`` unconditionally — it checked none of the 19 in-container step services, Redis,
Supabase, or the arq worker. Railway's healthcheck therefore could not detect B1 (step services run
as unsupervised background jobs, so a dead step leaves the container "healthy" while every job
routed through that step fails).

Two endpoint shapes are built on these probes:

* **health (liveness)** — is this container able to serve? Checks what a restart would actually fix,
  i.e. the in-container step processes. Returning 503 here lets the platform restart the container,
  which is the interim remedy for B1 until the process model collapses (B10).
* **readiness** — should traffic/jobs be routed here? Adds the external dependencies (Redis,
  Supabase, arq worker heartbeat). Deliberately separate so a transient Supabase blip degrades
  readiness instead of triggering a container restart loop.

Every probe is bounded by a short timeout and never raises: a probe that cannot answer is a failed
check, not a 500 on the health endpoint itself.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from writer_engine.telemetry.logging import get_logger

logger = get_logger("health")

DEFAULT_TIMEOUT_S = 2.0


@dataclass(frozen=True)
class CheckResult:
    """Outcome of one dependency probe.

    ``required`` distinguishes "restart/withdraw me" from "note it and keep serving".
    """

    name: str
    ok: bool
    detail: str = ""
    required: bool = True


async def probe_http(
    name: str,
    url: str,
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    required: bool = True,
) -> CheckResult:
    """GET ``url`` and treat any 2xx as healthy."""
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.get(url)
        if 200 <= resp.status_code < 300:
            return CheckResult(name=name, ok=True, required=required)
        return CheckResult(name=name, ok=False, detail=f"HTTP {resp.status_code}", required=required)
    except Exception as exc:
        return CheckResult(
            name=name, ok=False, detail=f"{type(exc).__name__}: {str(exc)[:120]}", required=required
        )


async def probe_redis(*, timeout_s: float = DEFAULT_TIMEOUT_S, required: bool = True) -> CheckResult:
    """PING Redis. Redis is the one stateful hinge (queue + budget + HITL gates + SSE + sessions)."""
    try:
        from writer_engine.redis_client.client import get_redis

        client = await get_redis()
        await asyncio.wait_for(client.ping(), timeout=timeout_s)
        return CheckResult(name="redis", ok=True, required=required)
    except Exception as exc:
        return CheckResult(
            name="redis", ok=False, detail=f"{type(exc).__name__}: {str(exc)[:120]}", required=required
        )


async def probe_supabase(*, timeout_s: float = DEFAULT_TIMEOUT_S, required: bool = False) -> CheckResult:
    """Cheapest possible authenticated read, to prove the service-role key still works.

    Not required by default: a Supabase blip should withdraw readiness, not restart the container.
    """
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        await asyncio.wait_for(
            client.table("users_v2").select("user_id").limit(1).execute(), timeout=timeout_s
        )
        return CheckResult(name="supabase", ok=True, required=required)
    except Exception as exc:
        return CheckResult(
            name="supabase",
            ok=False,
            detail=f"{type(exc).__name__}: {str(exc)[:120]}",
            required=required,
        )


async def probe_arq_worker(
    *,
    health_check_key: str,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    required: bool = False,
) -> CheckResult:
    """Check the arq worker heartbeat key.

    arq's ``Worker`` writes ``health_check_key`` every ``health_check_interval`` with a TTL just past
    that interval, so a missing key means no worker has reported recently. Only meaningful if the
    worker sets a short interval — see ``WorkerSettings.health_check_interval``.
    """
    try:
        from writer_engine.redis_client.client import get_redis

        client = await get_redis()
        raw = await asyncio.wait_for(client.get(health_check_key), timeout=timeout_s)
        if not raw:
            return CheckResult(
                name="arq_worker",
                ok=False,
                detail=f"no heartbeat at {health_check_key}",
                required=required,
            )
        detail = raw.decode() if isinstance(raw, bytes) else str(raw)
        return CheckResult(name="arq_worker", ok=True, detail=detail[:120], required=required)
    except Exception as exc:
        return CheckResult(
            name="arq_worker",
            ok=False,
            detail=f"{type(exc).__name__}: {str(exc)[:120]}",
            required=required,
        )


async def run_checks(probes: list[Any]) -> list[CheckResult]:
    """Await every probe concurrently; a probe that raises becomes a failed required check."""
    results = await asyncio.gather(*probes, return_exceptions=True)
    out: list[CheckResult] = []
    for item in results:
        if isinstance(item, CheckResult):
            out.append(item)
        else:
            out.append(CheckResult(name="unknown", ok=False, detail=f"probe raised: {str(item)[:120]}"))
    return out


def summarise(service: str, checks: list[CheckResult]) -> tuple[dict[str, Any], bool]:
    """Build the response body and decide whether the endpoint should return 200 or 503.

    ``status`` is ``ok`` when everything passed, ``degraded`` when only optional checks failed, and
    ``unhealthy`` when a required check failed. Only ``unhealthy`` should map to 503.
    """
    failed_required = [c.name for c in checks if c.required and not c.ok]
    failed_optional = [c.name for c in checks if not c.required and not c.ok]
    if failed_required:
        status = "unhealthy"
    elif failed_optional:
        status = "degraded"
    else:
        status = "ok"
    body: dict[str, Any] = {
        "status": status,
        "service": service,
        "checks": {
            c.name: {"ok": c.ok, **({"detail": c.detail} if c.detail else {}), "required": c.required}
            for c in checks
        },
    }
    if failed_required:
        body["failed_required"] = failed_required
    if failed_optional:
        body["failed_optional"] = failed_optional
    return body, not failed_required


__all__ = [
    "CheckResult",
    "probe_arq_worker",
    "probe_http",
    "probe_redis",
    "probe_supabase",
    "run_checks",
    "summarise",
]
