"""FastAPI app for the gateway.

The gateway is the only service the Workbench Express server (and, later, B2B customers) talks to. It exposes
``/internal/*`` (X-Service-Secret), ``/v1/*`` (API-key), ``/admin/*`` (admin token), and an SSE relay at
``/executions/{id}/events``.

The gateway delegates work to the orchestrator over HTTP.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi import status as http_status

from writer_engine import fleet
from writer_engine.config import get_settings
from writer_engine.health import probe_http, run_checks, summarise
from writer_engine.redis_client.client import close_redis, get_redis
from writer_engine.telemetry.logging import configure_logging, get_logger
from writer_engine.telemetry.metrics import HTTP_LATENCY, HTTP_REQUESTS, metrics_app, observe_latency

from .routes import admin, internal, sse, v1

SERVICE = "gateway"

REGISTER_INTERVAL_S = 30.0
"""How often a gateway replica records itself in the fleet registry (C1). A third of the TTL."""

_served = {"requests": 0}


async def _register_loop() -> None:
    """Keep this replica in the fleet registry. Never raises out: the registry is observability, and a
    Redis blip must not take the proxy down with it."""
    while True:
        with contextlib.suppress(Exception):
            await fleet.register(await get_redis(), SERVICE, requests_served=_served["requests"])
        await asyncio.sleep(REGISTER_INTERVAL_S)


@asynccontextmanager
async def lifespan(_: FastAPI) -> Any:
    settings = get_settings()
    configure_logging(level=settings.log_level, service=SERVICE)
    logger = get_logger(SERVICE)
    logger.info("gateway.startup", orchestrator_url=settings.orchestrator_url, instance=fleet.instance_id())
    fleet.mark_instance(SERVICE)
    task = asyncio.create_task(_register_loop(), name="gateway-fleet-register")
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        with contextlib.suppress(Exception):
            await fleet.deregister(await get_redis(), SERVICE)
        await close_redis()
        logger.info("gateway.shutdown")


def build_app() -> FastAPI:
    app = FastAPI(
        title="Writer Engine — gateway",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    @app.middleware("http")
    async def metrics_middleware(request: Request, call_next: Callable[..., Any]) -> Any:
        route = request.url.path
        method = request.method
        with observe_latency(HTTP_LATENCY, service=SERVICE, route=route, method=method):
            response = await call_next(request)
        HTTP_REQUESTS.labels(
            service=SERVICE, route=route, method=method, status=str(response.status_code)
        ).inc()
        _served["requests"] += 1
        # Which replica answered — how the load balancing across replicas is checked from outside.
        response.headers["X-Engine-Instance"] = fleet.instance_id()
        return response

    @app.get("/admin/health")
    async def health() -> dict[str, str]:
        """Liveness. Flat OK is correct here: the gateway is a stateless proxy, so the only thing a
        restart fixes is the process being wedged — which this answering at all disproves.

        Deliberately does NOT check the orchestrator (B2): if it did, an orchestrator restart would
        fail the gateway's healthcheck too and restart it in sympathy. The orchestrator dependency
        belongs in /admin/ready, which withdraws the instance from the load balancer without
        bouncing it.
        """
        return {"status": "ok", "service": SERVICE}

    @app.get("/admin/ready")
    async def ready(response: Response) -> dict[str, Any]:
        """Readiness — can this gateway usefully serve? Requires the orchestrator it forwards to.

        The hook for multi-replica routing + graceful drain (B7/C1).
        """
        checks = await run_checks(
            [
                probe_http(
                    "orchestrator",
                    f"{get_settings().orchestrator_url}/admin/health",
                    required=True,
                )
            ]
        )
        body, ok = summarise(SERVICE, checks)
        if not ok:
            response.status_code = http_status.HTTP_503_SERVICE_UNAVAILABLE
        return body

    @app.get("/metrics")
    async def metrics() -> Any:
        return metrics_app()

    app.include_router(admin.router, prefix="/admin", tags=["admin"])
    app.include_router(internal.router, prefix="/internal", tags=["internal"])
    app.include_router(v1.router, prefix="/v1", tags=["v1"])
    app.include_router(sse.router, tags=["sse"])
    return app


app = build_app()
