"""Build a FastAPI ``app`` for a step service from a single handler.

A step service is the smallest deployable unit in the engine. The template wires up:

- ``POST /run``       — the uniform step contract (StepInput → StepOutput); X-Service-Secret required.
- ``GET  /admin/health`` — liveness.
- ``GET  /metrics``    — Prometheus exposition.
- structured logging, metric labels, and uniform error → ``StepOutput`` translation.

A concrete step service is just::

    from writer_engine.step_service import build_step_app
    from writer_engine.schemas import StepInput, StepOutput, StepStatus

    async def handler(inp: StepInput) -> StepOutput:
        return StepOutput(execution_id=inp.execution_id, step_name=inp.step_name, payload={...})

    app = build_step_app("my_step", handler)
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, status

from writer_engine.auth import require_admin_token, require_service_secret
from writer_engine.config import get_settings
from writer_engine.redis_client.client import close_redis
from writer_engine.schemas import StepError, StepInput, StepOutput, StepStatus
from writer_engine.telemetry.logging import configure_logging, get_logger
from writer_engine.telemetry.metrics import (
    HTTP_LATENCY,
    HTTP_REQUESTS,
    STEP_LATENCY,
    metrics_app,
    observe_latency,
)

StepHandler = Callable[[StepInput], Awaitable[StepOutput]]


def build_step_app(step_name: str, handler: StepHandler) -> FastAPI:
    """Return a configured FastAPI ``app`` for a step service."""
    settings = get_settings()
    configure_logging(level=settings.log_level, service=step_name)
    logger = get_logger(step_name)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> Any:
        logger.info("step_service.startup", step=step_name, picker_model=settings.picker_model)
        try:
            yield
        finally:
            await close_redis()
            logger.info("step_service.shutdown", step=step_name)

    app = FastAPI(title=f"writer-engine step: {step_name}", version="0.1.0", lifespan=lifespan)

    @app.middleware("http")
    async def metrics_middleware(request: Request, call_next: Callable[..., Any]) -> Any:
        route = request.url.path
        method = request.method
        with observe_latency(HTTP_LATENCY, service=step_name, route=route, method=method):
            response = await call_next(request)
        HTTP_REQUESTS.labels(
            service=step_name, route=route, method=method, status=str(response.status_code)
        ).inc()
        return response

    @app.get("/admin/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "step": step_name}

    @app.get("/admin/info", dependencies=[Depends(require_admin_token)])
    async def info() -> dict[str, Any]:
        return {"step": step_name, "picker_model": settings.picker_model}

    @app.get("/metrics")
    async def metrics() -> Any:
        return metrics_app()

    @app.post("/run", dependencies=[Depends(require_service_secret)], response_model=StepOutput)
    async def run(inp: StepInput) -> StepOutput:
        if inp.step_name != step_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"step_name mismatch: this service handles '{step_name}', got '{inp.step_name}'",
            )
        try:
            with observe_latency(STEP_LATENCY, service=step_name, step=step_name, status="ok"):
                return await handler(inp)
        except HTTPException:
            raise
        except Exception as exc:  # log + return structured error envelope
            logger.exception("step.error", step=step_name, execution_id=str(inp.execution_id))
            return StepOutput(
                execution_id=inp.execution_id,
                step_name=step_name,
                status=StepStatus.ERROR,
                error=StepError(code=type(exc).__name__, message=str(exc)),
            )

    return app
