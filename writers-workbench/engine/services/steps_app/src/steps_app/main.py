"""Single-process aggregator mounting every step service under ``/steps/<name>`` (B10).

The runtime container used to run **21 processes**: 19 step services as separate uvicorns plus the
arq worker and the orchestrator. The per-step *architecture* was never the problem — each step is a
separate FastAPI app with its own ``StepInput``/``StepOutput`` contract, and that is preserved here
exactly. What the 19 processes cost was:

* **B3** — ``MAX_CONCURRENT_LLM`` lives in the ``LLMRouter`` module singleton, so there were ~19
  independent semaphores. The documented per-instance cap of 12 was really up to 12 x 19, which is
  why CR-003's "~10 users per instance" sizing had no basis. One process = one router = one
  semaphore that means what the docs say.
* **A5** — ``PromptStore`` is likewise a module global, so ``/admin/reload-prompts`` reloaded one
  process's prompts and left the 19 that actually generate text untouched. One process makes the
  reload reach every step; see ``/admin/reload-prompts`` below.
* ~19 Python interpreters each importing anthropic/httpx/pydantic.

**The split is still one env var away.** The orchestrator dials every step through
``<NAME>_STEP_URL``, so this collapse only changes what those point at
(``http://localhost:8030/steps/chapter`` instead of ``http://localhost:8020``). Peeling a step back
out into its own container means pointing its variable at a hostname — no code change. The
``docker-compose.yml`` stack still runs one container per step and exercises exactly that path.

Mounted sub-app lifespans are deliberately NOT propagated: the step template's lifespan only emits a
startup log line and calls ``close_redis()``, and closing the shared Redis client 19 times on
shutdown would be wrong. The aggregator owns that once, below.
"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

from approval_step.main import app as approval_app
from assemble_step.main import app as assemble_app
from brainstorm_step.main import app as brainstorm_app
from chapter_step.main import app as chapter_app
from deliver_step.main import app as deliver_app
from fastapi import Depends, FastAPI, Request
from gather_step.main import app as gather_app
from image_step.main import app as image_app
from library_step.main import app as library_app
from media_step.main import app as media_app
from notify_step.main import app as notify_app
from persist_step.main import app as persist_app
from pick_step.main import app as pick_app
from render_step.main import app as render_app
from research_step.main import app as research_app
from scrape_step.main import app as scrape_app
from segment_step.main import app as segment_app
from story_bible_step.main import app as story_bible_app
from subject_step.main import app as subject_app

from library_retrieve_step.main import app as library_retrieve_app
from writer_engine.auth import require_admin_token
from writer_engine.config import get_settings
from writer_engine.prompt_store import get_prompt_store
from writer_engine.redis_client.client import close_redis
from writer_engine.runtime_processes import STEP_MOUNT_PREFIX
from writer_engine.telemetry.logging import configure_logging, get_logger
from writer_engine.telemetry.metrics import HTTP_LATENCY, HTTP_REQUESTS, metrics_app, observe_latency

SERVICE = "steps"

# name -> the step's FastAPI app. Keys MUST match writer_engine.runtime_processes.STEP_NAMES; a test
# asserts that, because a step missing here is a step the orchestrator cannot reach.
STEP_APPS: dict[str, FastAPI] = {
    "library_retrieve": library_retrieve_app,
    # Newsletter saga steps (F2).
    "gather": gather_app,
    "pick": pick_app,
    "subject": subject_app,
    "scrape": scrape_app,
    "segment": segment_app,
    "image": image_app,
    "assemble": assemble_app,
    "render": render_app,
    "persist": persist_app,
    "deliver": deliver_app,
    # Write-workshop steps (F1).
    "chapter": chapter_app,
    "research": research_app,
    "brainstorm": brainstorm_app,
    "media": media_app,
    "library": library_app,
    "story_bible": story_bible_app,
    "approval": approval_app,
    "notify": notify_app,
}


def mount_path(name: str) -> str:
    """Where a step is mounted. Mirrors ``runtime_processes.step_mount_path``."""
    return f"{STEP_MOUNT_PREFIX}/{name}"


def build_app() -> FastAPI:
    settings = get_settings()
    configure_logging(level=settings.log_level, service=SERVICE)
    logger = get_logger(SERVICE)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> Any:
        logger.info("steps_app.startup", steps=len(STEP_APPS))
        try:
            yield
        finally:
            # Once, for the whole process — the mounted sub-apps share this client.
            await close_redis()
            logger.info("steps_app.shutdown")

    app = FastAPI(title="writer-engine: steps", version="0.1.0", lifespan=lifespan)

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
    async def health() -> dict[str, Any]:
        """Aggregator liveness. Per-step reachability is probed via each mount's own health route."""
        return {"status": "ok", "service": SERVICE, "steps": len(STEP_APPS)}

    @app.post("/admin/reload-prompts", dependencies=[Depends(require_admin_token)])
    async def reload_prompts() -> dict[str, int]:
        """Reload prompt overrides for every step (A5).

        The store is a module global, and all steps now share this process, so one reload covers all
        of them — which is what makes prompt tuning actually deployable. The gateway's
        ``/admin/reload-prompts`` proxies here rather than reloading its own unused copy.
        """
        count = await get_prompt_store().reload_from_supabase()
        logger.info("steps_app.prompts_reloaded", count=count)
        return {"loaded": count}

    @app.get("/metrics")
    async def metrics() -> Any:
        return metrics_app()

    for name, step_app in STEP_APPS.items():
        app.mount(mount_path(name), step_app)

    logger.info("steps_app.mounted", paths=[mount_path(n) for n in STEP_APPS])
    return app


app = build_app()

__all__ = ["STEP_APPS", "app", "build_app", "mount_path"]
