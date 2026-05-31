"""FastAPI app for the gateway.

The gateway is the only service the Workbench Express server (and, later, B2B customers) talks to. It exposes
``/internal/*`` (X-Service-Secret), ``/v1/*`` (API-key), ``/admin/*`` (admin token), and an SSE relay at
``/executions/{id}/events``.

The gateway delegates work to the orchestrator over HTTP.
"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request

from writer_engine.config import get_settings
from writer_engine.redis_client.client import close_redis
from writer_engine.telemetry.logging import configure_logging, get_logger
from writer_engine.telemetry.metrics import HTTP_LATENCY, HTTP_REQUESTS, metrics_app, observe_latency

from .routes import admin, internal, sse, v1

SERVICE = "gateway"


@asynccontextmanager
async def lifespan(_: FastAPI) -> Any:
    settings = get_settings()
    configure_logging(level=settings.log_level, service=SERVICE)
    logger = get_logger(SERVICE)
    logger.info("gateway.startup", orchestrator_url=settings.orchestrator_url)
    try:
        yield
    finally:
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
        return response

    @app.get("/admin/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": SERVICE}

    @app.get("/metrics")
    async def metrics() -> Any:
        return metrics_app()

    app.include_router(admin.router, prefix="/admin", tags=["admin"])
    app.include_router(internal.router, prefix="/internal", tags=["internal"])
    app.include_router(v1.router, prefix="/v1", tags=["v1"])
    app.include_router(sse.router, tags=["sse"])
    return app


app = build_app()
