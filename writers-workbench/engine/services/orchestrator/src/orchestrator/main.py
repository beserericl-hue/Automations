"""Orchestrator FastAPI app — runs a pipeline synchronously for F0 vertical slice.

Long-running pipelines (newsletter, chapter) switch to arq enqueue in F2/F1 — same handler, different transport.
"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID, uuid4

import httpx
from arq import create_pool
from arq.jobs import Job
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi import status as http_status

from writer_engine.auth import require_admin_token, require_service_secret
from writer_engine.cadence import INTERVAL_DAYS, is_due
from writer_engine.config import get_settings
from writer_engine.health import (
    probe_arq_worker,
    probe_http,
    probe_redis,
    probe_supabase,
    run_checks,
    summarise,
)
from writer_engine.queues import (
    ALL_QUEUES,
    POLL_QUEUES,
    QUEUE_HEAVY,
    QUEUE_LEGACY,
    profile_for,
    queue_for,
    read_dead_letters,
)
from writer_engine.redis_client.client import close_redis
from writer_engine.scheduler import Job as CronJob
from writer_engine.scheduler import Scheduler
from writer_engine.scheduler import start as scheduler_start
from writer_engine.scheduler import stop as scheduler_stop
from writer_engine.state_machine.durable import RedisSagaRepo
from writer_engine.state_machine.orchestrator import InMemoryStateStore
from writer_engine.state_machine.saga import StepRef, run_step_via_http
from writer_engine.telemetry.logging import configure_logging, get_logger
from writer_engine.telemetry.metrics import HTTP_LATENCY, HTTP_REQUESTS, metrics_app, observe_latency
from writer_engine.watchdog import Watchdog
from writer_engine.watchdog import start as watchdog_start
from writer_engine.watchdog import stop as watchdog_stop

from .library_orch import LibraryRetrieveOrchestrator
from .newsletter_orch import NewsletterOrchestrator, resolution_hook_installed
from .newsletter_saga import NewsletterSagaDriver
from .worker import ARQ_HEALTH_CHECK_KEY, build_redis_settings
from .write_tools import ALL_STEP_URLS, is_async, resolve_step_url

# When set, the durable saga driver enqueues advance via this arq pool. Tests set it to None and drive
# advance() directly so they don't need a live Redis + arq worker.
_arq_pool = None

SERVICE = "orchestrator"
logger = get_logger(SERVICE)


async def _readiness_with_verdict() -> tuple[dict[str, Any], bool]:
    """Run every readiness probe. Returns the response body and whether it is servable.

    Module level, not a closure: the watchdog (C2) evaluates the same probes on a timer, and a
    second copy of this list would drift — the kind of drift where a newly added dependency is
    checked by the endpoint and not by the monitor, so nothing alerts on it.
    """
    settings = get_settings()
    probes: list[Any] = [
        probe_http(f"step:{name}", f"{getter(settings)}/admin/health")
        for name, getter in ALL_STEP_URLS.items()
    ]
    probes.append(probe_redis(required=True))
    # One probe per queue (B4): with two workers, "a worker is alive" is not the question — a dead
    # interactive worker leaves every Q/A queued while heavy work looks fine.
    probes += [
        probe_arq_worker(
            health_check_key=f"{ARQ_HEALTH_CHECK_KEY}:{queue}",
            name=f"arq_worker:{queue}",
            required=False,
        )
        for queue in ALL_QUEUES
    ]
    probes.append(probe_supabase(required=False))
    checks = await run_checks(probes)
    return summarise(SERVICE, checks)


async def _readiness() -> dict[str, Any]:
    """Just the body — the shape the watchdog consumes."""
    body, _ok = await _readiness_with_verdict()
    return body


@asynccontextmanager
async def lifespan(app: FastAPI) -> Any:
    settings = get_settings()
    configure_logging(level=settings.log_level, service=SERVICE)
    logger = get_logger(SERVICE)
    logger.info("orchestrator.startup")
    # Best-effort: create the arq pool so the saga driver can enqueue advance jobs after a resolve. If Redis is
    # unreachable (e.g. tests without fakeredis-wired arq), fall back to driving advance() inline.
    try:
        app.state.arq_pool = await create_pool(build_redis_settings())
    except Exception as exc:
        logger.warning("arq pool unavailable; saga driver will run advance() inline", error=str(exc))
        app.state.arq_pool = None

    # C2: the watchdog. /admin/ready has told the truth since B2, but only to whoever asked it —
    # which is how the 2026-05-19 Redis outage ran for nine days. This re-runs the same probes on a
    # timer and emails on a transition. It evaluates `_readiness()` rather than HTTP-ing its own
    # route, so it keeps working when the public listener is the thing that is wedged.
    app.state.watchdog_task = None
    if settings.watchdog_interval_seconds > 0:
        dog = Watchdog(
            _readiness,
            interval_s=settings.watchdog_interval_seconds,
            service=SERVICE,
            dead_letters=read_dead_letters,
        )
        app.state.watchdog_task = watchdog_start(dog)

    # E1: the engine's own clock. Ingestion and the newsletter cadence were both driven by n8n
    # schedule triggers, so without this "n8n off" would mean the corpus stops being refilled and
    # no edition is ever generated — silently, in both cases. `create_app` builds the job list;
    # jobs whose interval is 0 are dropped by the Scheduler, and an empty list means no task.
    app.state.scheduler = None
    app.state.scheduler_task = None
    jobs = list(getattr(app.state, "cron_jobs", []) or [])
    scheduler = Scheduler(jobs)
    if scheduler.jobs:
        app.state.scheduler = scheduler
        app.state.scheduler_task = scheduler_start(scheduler)

    try:
        yield
    finally:
        await scheduler_stop(getattr(app.state, "scheduler_task", None))
        await watchdog_stop(getattr(app.state, "watchdog_task", None))
        if getattr(app.state, "arq_pool", None) is not None:
            await app.state.arq_pool.close()
        await close_redis()


def build_app() -> FastAPI:
    app = FastAPI(title="Writer Engine — orchestrator", version="0.1.0", lifespan=lifespan)
    app.state.store = InMemoryStateStore()
    # Default to RedisSagaRepo in production; tests override via dependency injection / monkeypatch.
    app.state.saga_repo = RedisSagaRepo()
    app.state.arq_pool = None  # set in lifespan if reachable

    def _make_saga_driver() -> NewsletterSagaDriver:
        async def enqueue(execution_id: UUID) -> None:
            if app.state.arq_pool is not None:
                await app.state.arq_pool.enqueue_job(
                    "advance_newsletter_saga", str(execution_id), _queue_name=QUEUE_HEAVY
                )

        return NewsletterSagaDriver(app.state.saga_repo, enqueue_advance=enqueue)

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
    async def health(response: Response) -> dict[str, Any]:
        """Liveness — can this container serve? (B2)

        Probes every in-container step service. These run as background processes in the same
        container (B1), so an unreachable step means this container is broken and a restart is the
        correct remedy — hence 503, which Railway's healthcheck acts on. External dependencies are
        deliberately NOT checked here; they belong in /admin/ready so a Supabase or Redis blip
        degrades readiness instead of causing a container restart loop.
        """
        settings = get_settings()
        checks = await run_checks(
            [
                probe_http(f"step:{name}", f"{getter(settings)}/admin/health")
                for name, getter in ALL_STEP_URLS.items()
            ]
        )
        body, ok = summarise(SERVICE, checks)
        if not ok:
            response.status_code = http_status.HTTP_503_SERVICE_UNAVAILABLE
            logger.error("health.unhealthy", failed=body.get("failed_required"))
        return body

    @app.get("/admin/ready")
    async def ready(response: Response) -> dict[str, Any]:
        """Readiness — should work be routed here? (B2)

        Everything /admin/health checks, plus Redis (required — it carries the queue, the shared
        provider budgets, the HITL gates and SSE), both arq worker heartbeats and Supabase. The
        latter are optional so a blip reports `degraded` rather than withdrawing the instance.

        This is the hook a load balancer, the graceful-drain work (B7) and the C2 watchdog build on.
        The evaluation itself lives in ``_readiness`` so the watchdog runs the SAME probes rather
        than a drifting copy of them — and so it does not have to HTTP its own process.
        """
        body, ok = await _readiness_with_verdict()
        if not ok:
            response.status_code = http_status.HTTP_503_SERVICE_UNAVAILABLE
            logger.error("ready.unhealthy", failed=body.get("failed_required"))
        return body

    @app.post("/admin/reload-prompts", dependencies=[Depends(require_admin_token)])
    async def reload_prompts() -> dict[str, Any]:
        """Reload prompts here and in the steps process (A5).

        The orchestrator shares the runtime container with the steps process, so it is the only
        service that can reach it (the steps app binds to localhost). The gateway fans out to this
        route rather than trying to reach the steps app itself.
        """
        from writer_engine.prompt_store import get_prompt_store

        local = await get_prompt_store().reload_from_supabase()
        out: dict[str, Any] = {"orchestrator_loaded": local}

        steps_url = get_settings().steps_admin_url
        if not steps_url:
            out["steps_error"] = "STEPS_ADMIN_URL unset"
            return out
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{steps_url.rstrip('/')}/admin/reload-prompts",
                    headers={"x-admin-token": get_settings().admin_token},
                )
                resp.raise_for_status()
                out["steps_loaded"] = int((resp.json() or {}).get("loaded", 0))
        except Exception as exc:
            logger.warning("orchestrator.reload_prompts.steps_failed", error=str(exc)[:200])
            out["steps_error"] = f"{type(exc).__name__}: {str(exc)[:160]}"
        return out

    @app.get("/admin/dlq", dependencies=[Depends(require_admin_token)])
    async def dlq(limit: int = 50) -> dict[str, Any]:
        """Terminal job failures (B5).

        arq keeps a failed job's result only for ``keep_result`` seconds and then forgets it, so
        without this a failed chapter write leaves nothing behind to point at. Entries are
        most-recent-first and capped; see ``writer_engine.queues.DLQ_MAX``.
        """
        entries = await read_dead_letters(limit=max(1, min(limit, 500)))
        return {"count": len(entries), "entries": entries}

    @app.get("/admin/dashboard", dependencies=[Depends(require_admin_token)])
    async def dashboard() -> dict[str, Any]:
        """One request that answers "is the engine healthy, busy, or stuck?" (C1).

        Everything here was already knowable, but only by assembling four separate calls and
        knowing which Redis keys to read — which in practice meant nobody looked. The fields are
        chosen to answer the three questions actually asked during an incident:

          is it up          -> readiness, per dependency
          is it working     -> queue depth and in-flight count, per queue
          what broke        -> the most recent dead letters, newest first

        Admin-token gated: queue contents and job arguments name users and projects.
        """
        from arq.jobs import JobStatus

        body, servable = await _readiness_with_verdict()
        out: dict[str, Any] = {
            "status": body.get("status"),
            "servable": servable,
            "checks": body.get("checks", {}),
        }

        queues: dict[str, Any] = {}
        for name in POLL_QUEUES:
            profile = profile_for(name)
            entry: dict[str, Any] = {
                "max_jobs": profile.max_jobs,
                "job_timeout_s": profile.job_timeout,
                "max_tries": profile.max_tries,
            }
            if name == QUEUE_LEGACY:
                # Pre-split queue: shown only so a non-zero depth after a deploy is visible while
                # it drains. Nothing is ever enqueued here.
                entry = {"legacy": True}
            if app.state.arq_pool is not None:
                try:
                    jobs = await app.state.arq_pool.queued_jobs(queue_name=name)
                    # arq keeps a job in the queue's sorted set while it runs, so "queued" alone
                    # would count running work as waiting — which is the difference between
                    # "backed up" and "busy".
                    running = 0
                    waiting = 0
                    for job in jobs:
                        status = await Job(
                            job.job_id or "", redis=app.state.arq_pool, _queue_name=name
                        ).status()
                        if status == JobStatus.in_progress:
                            running += 1
                        else:
                            waiting += 1
                    entry["running"] = running
                    entry["waiting"] = waiting
                    entry["depth"] = len(jobs)
                except Exception as exc:
                    entry["error"] = f"{type(exc).__name__}: {str(exc)[:120]}"
            queues[name] = entry
        out["queues"] = queues

        entries = await read_dead_letters(limit=10)
        out["dead_letters"] = {"recent": entries, "shown": len(entries)}
        return out

    @app.get("/metrics")
    async def metrics() -> Any:
        return metrics_app()

    @app.post("/pipelines/library_retrieve/run", dependencies=[Depends(require_service_secret)])
    async def run_library_retrieve(body: dict[str, Any]) -> dict[str, Any]:
        orch = LibraryRetrieveOrchestrator(app.state.store)
        exec_id_str = body.get("execution_id")
        if exec_id_str:
            execution_id: UUID = UUID(exec_id_str)
            await orch.start(execution_id=execution_id, initial_state=body)
        else:
            execution_id = await orch.start(initial_state=body)
        return await orch.run(execution_id, payload=body)

    async def _locate_job(job_id: str) -> tuple[Any, Any, str | None]:
        """Find which queue holds ``job_id``.

        A caller holding a job_id does not know which queue took it, and arq's ``Job`` is bound to
        one queue name at construction: ``status()`` reads the queue's own sorted set, so asking the
        wrong queue reports ``not_found`` for a job that is sitting there queued. Try each queue and
        take the first that recognises the id. ``POLL_QUEUES`` includes the pre-split ``newsletter``
        queue so jobs enqueued before a deploy keep polling correctly while they drain.

        The returned queue is ``None`` unless it is actually known. ``complete`` and ``in_progress``
        come from queue-INDEPENDENT keys (``arq:result:<id>`` and ``arq:in-progress:<id>``), so the
        first queue asked answers for a job that ran anywhere — naming that queue in the response
        would be a guess dressed as a fact. Only ``queued``/``deferred`` are derived from a specific
        queue's sorted set and can be attributed.
        """
        from arq.jobs import Job, JobStatus

        attributable = {JobStatus.queued, JobStatus.deferred}
        first: tuple[Any, Any, str | None] | None = None
        for queue in POLL_QUEUES:
            job = Job(job_id, redis=app.state.arq_pool, _queue_name=queue)
            status = await job.status()
            if status != JobStatus.not_found:
                return job, status, (queue if status in attributable else None)
            if first is None:
                first = (job, status, None)
        assert first is not None  # POLL_QUEUES is never empty
        return first

    @app.post("/pipelines/write/{tool}/run", dependencies=[Depends(require_service_secret)])
    async def run_write_tool(tool: str, body: dict[str, Any]) -> dict[str, Any]:
        """F1-B: dispatch to a write-workshop step (chapter/research/brainstorm/...).

        Heavy tools (chapter fan-out, full-novel outline) default to ASYNC: enqueue an arq job and
        return ``{job_id, status: "queued"}`` immediately (under the ~300s edge limit); the caller
        polls ``GET /pipelines/write/jobs/{job_id}``. Pass ``async: false`` to force the synchronous
        path. The tool name must match the step's STEP_NAME (so StepInput validates).
        """
        url = resolve_step_url(tool, get_settings())
        if url is None:
            raise HTTPException(http_status.HTTP_404_NOT_FOUND, detail=f"unknown write tool: {tool}")

        if is_async(tool, body):
            if app.state.arq_pool is None:
                raise HTTPException(
                    http_status.HTTP_503_SERVICE_UNAVAILABLE, detail="async queue unavailable"
                )
            # B4: route by (tool, op). A chapter write goes to the heavy queue; a Q/A or a plan
            # goes to the interactive queue, where it is not stuck behind a 96-chapter batch.
            queue = queue_for(tool, body.get("op"))
            job = await app.state.arq_pool.enqueue_job("run_write_tool_job", tool, body, _queue_name=queue)
            return {"job_id": job.job_id, "status": "queued", "tool": tool, "queue": queue}

        exec_id = body.get("execution_id")
        out = await run_step_via_http(
            StepRef(name=tool, url=url),
            execution_id=UUID(exec_id) if exec_id else uuid4(),
            payload=body,
            timeout_s=float(body.get("timeout_s") or 600.0),
        )
        return out.model_dump(mode="json")

    @app.get("/pipelines/write/jobs/{job_id}", dependencies=[Depends(require_service_secret)])
    async def write_job_status(job_id: str) -> dict[str, Any]:
        """Poll an async write-tool job: returns {status, result?}. status ∈ queued|in_progress|complete|not_found."""
        from arq.jobs import JobStatus

        if app.state.arq_pool is None:
            raise HTTPException(http_status.HTTP_503_SERVICE_UNAVAILABLE, detail="async queue unavailable")
        job, status, queue = await _locate_job(job_id)
        out: dict[str, Any] = {"job_id": job_id, "status": status.value}
        if queue is not None:
            out["queue"] = queue
        if status == JobStatus.complete:
            try:
                out["result"] = await job.result(timeout=1)
            except Exception as exc:  # job failed inside the worker
                out["status"] = "error"
                out["error"] = str(exc)[:300]
        return out

    @app.post("/pipelines/write/jobs/{job_id}/abort", dependencies=[Depends(require_service_secret)])
    async def abort_write_job(job_id: str) -> dict[str, Any]:
        """Cancel an async write-tool job (Fix Drift "Cancel"). Sets arq's abort flag: a still-queued job is
        dropped before it starts; a running job is cancelled at its next await. Aborted jobs are not retried.

        Returns ``{job_id, aborted}`` where ``aborted`` is arq's confirmation. A job that already completed
        (or never existed) returns ``aborted: false`` rather than erroring — cancel is idempotent/safe to spam.
        """
        if app.state.arq_pool is None:
            raise HTTPException(http_status.HTTP_503_SERVICE_UNAVAILABLE, detail="async queue unavailable")
        job, _status, _queue = await _locate_job(job_id)
        try:
            aborted = await job.abort(timeout=2)
        except Exception as exc:  # already finished / result expired — nothing to abort
            logger.info("write_job.abort.noop", job_id=job_id, error=str(exc)[:200])
            aborted = False
        logger.info("write_job.abort", job_id=job_id, aborted=aborted)
        return {"job_id": job_id, "aborted": aborted}

    @app.get("/pipelines/{pipeline}/state/{execution_id}", dependencies=[Depends(require_service_secret)])
    async def get_state(pipeline: str, execution_id: str) -> dict[str, Any]:
        state = await app.state.store.load(UUID(execution_id))
        return state.model_dump(mode="json")

    @app.post("/pipelines/newsletter/run", dependencies=[Depends(require_service_secret)])
    async def run_newsletter(body: dict[str, Any]) -> dict[str, Any]:
        """Synchronous newsletter run — TEST ONLY (A10).

        ``NewsletterOrchestrator`` auto-resolves the three HITL gates via the test hook, which is
        what the in-process L2 test needs and what must never happen to a real newsletter: it would
        send without any human review of stories, subject or images. Any holder of the service
        secret could previously reach this route, so it now refuses unless a test has installed the
        hook. Production goes to ``/pipelines/newsletter/run-durable``.
        """
        if not resolution_hook_installed():
            raise HTTPException(
                status_code=http_status.HTTP_410_GONE,
                detail=(
                    "/pipelines/newsletter/run is test-only (it auto-approves the HITL gates). "
                    "Use /pipelines/newsletter/run-durable."
                ),
            )
        orch = NewsletterOrchestrator(app.state.store)
        exec_id_str = body.get("execution_id")
        if exec_id_str:
            execution_id: UUID = UUID(exec_id_str)
            await orch.start(execution_id=execution_id, initial_state=body)
        else:
            execution_id = await orch.start(initial_state=body)
        return await orch.run(execution_id, payload=body)

    @app.post("/pipelines/newsletter/run-durable", dependencies=[Depends(require_service_secret)])
    async def run_newsletter_durable(body: dict[str, Any]) -> dict[str, Any]:
        """Durable newsletter run. Persists state to SagaStateRepo, releases worker at HITL gates, resumed via
        ``POST /approvals/{token}/resolve``. Returns immediately with ``execution_id`` after the first batch of
        stages (gather + pick) — the UI polls SSE / status for the rest."""
        driver = _make_saga_driver()
        cfg = {
            "edition_id": body.get("edition_id", ""),
            "send_date": body.get("send_date", ""),
            "user_id": body.get("user_id", ""),
            "max_stories": int(body.get("max_stories", 5)),
            "previous_newsletter_content": body.get("previous_newsletter_content", ""),
            # Edition theme so the pick step selects on-topic stories (see NewsletterSagaDriver
            # ._stage_picking). Absent/None for editions with no genre configured.
            "genre": body.get("genre") or None,
            "newsletter_name": body.get("newsletter_name") or None,
        }
        execution_id = await driver.start(cfg=cfg)
        # If arq is available, hand off to the worker; else drive inline so the response carries the first pause.
        if app.state.arq_pool is not None:
            await app.state.arq_pool.enqueue_job(
                "advance_newsletter_saga", str(execution_id), _queue_name=QUEUE_HEAVY
            )
            return {"execution_id": str(execution_id), "result": "queued"}
        result = await driver.advance(execution_id)
        return {"execution_id": str(execution_id), "result": result.value}

    @app.post("/approvals/{token}/resolve", dependencies=[Depends(require_service_secret)])
    async def resolve_approval_route(token: str, body: dict[str, Any]) -> dict[str, Any]:
        from writer_engine.state_machine.hitl import (
            ApprovalDecision,
            get_approval,
            resolve_approval,
        )

        gate = await get_approval(token)
        if gate is None:
            from fastapi import HTTPException, status

            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="approval token unknown")

        try:
            decision = ApprovalDecision(str(body.get("decision") or "approve"))
        except ValueError as exc:
            from fastapi import HTTPException, status

            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="bad decision value") from exc

        await resolve_approval(token, decision=decision, feedback=body.get("feedback"))

        driver = _make_saga_driver()
        await driver.apply_decision(
            gate.execution_id,
            gate_stage=gate.stage,
            decision=decision,
            feedback=body.get("feedback"),
            chosen_images=body.get("chosen_images"),
        )
        # If arq isn't available, drive advance inline so callers see immediate progress.
        if app.state.arq_pool is None:
            await driver.advance(gate.execution_id)
        return {"execution_id": str(gate.execution_id), "resumed": True}

    @app.get(
        "/pipelines/newsletter/saga-state/{execution_id}",
        dependencies=[Depends(require_service_secret)],
    )
    async def newsletter_saga_state(execution_id: str) -> dict[str, Any]:
        from fastapi import HTTPException
        from fastapi import status as http_status

        try:
            state = await app.state.saga_repo.load(UUID(execution_id))
        except KeyError as exc:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="execution not found"
            ) from exc
        return state.model_dump(mode="json")

    def _require_cron_secret(request: Request) -> None:
        from fastapi import HTTPException
        from fastapi import status as http_status

        expected = (get_settings().admin_token or "").strip()
        provided = (request.headers.get("x-cron-secret") or "").strip()
        if not provided or provided != expected:
            raise HTTPException(http_status.HTTP_401_UNAUTHORIZED, detail="missing or invalid X-Cron-Secret")

    async def _cadence_tick() -> dict[str, Any]:
        """The cadence cron's body, callable without an HTTP request.

        Split out so the internal scheduler can run it (E1): until now the only thing that ever
        called ``/cron/newsletter-cadence`` was an n8n schedule trigger, so turning n8n off would
        have stopped the newsletter from ever being generated — with no error, because an endpoint
        nobody calls looks exactly like an endpoint with nothing to do.
        """
        from datetime import UTC, datetime

        from writer_engine.supabase.client import get_supabase_admin

        try:
            client = await get_supabase_admin()
        except Exception:
            return {"enqueued": 0, "skipped_reason": "supabase not configured"}

        # "Due" is derived from cadence + the last send, mirroring the WW computeDueEditions path
        # (server/src/routes/newsletter-edition-extras.ts). newsletter_editions_v2 has no
        # next_scheduled_send_at/timezone columns — the only cadence columns are `cadence` and
        # `cadence_send_time`. A11: the decision now lives in writer_engine.cadence, which anchors
        # the due moment to the SEND TIME rather than adding seconds to the last send. The old
        # arithmetic ignored cadence_send_time completely, so a 09:00 weekly edition drifted later
        # every week and could go out at 00:05.
        now = datetime.now(UTC)
        zone = get_settings().newsletter_timezone
        resp = await (
            client.table("newsletter_editions_v2")
            .select("id,user_id,cadence,cadence_send_time,created_at")
            .eq("enabled", True)
            .neq("cadence", "none")
            .execute()
        )
        editions = list(getattr(resp, "data", None) or [])

        due_editions: list[dict[str, Any]] = []
        for ed in editions:
            if str(ed.get("cadence") or "").strip().lower() not in INTERVAL_DAYS:
                continue
            last = await (
                client.table("newsletter_sends_v2")
                .select("created_at")
                .eq("edition_id", ed.get("id"))
                .eq("user_id", ed.get("user_id"))
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            last_rows = list(getattr(last, "data", None) or [])
            baseline_iso = last_rows[0]["created_at"] if last_rows else ed.get("created_at")
            due, reason = is_due(
                cadence=str(ed.get("cadence") or ""),
                baseline=baseline_iso,
                send_time=ed.get("cadence_send_time"),
                timezone=zone,
                now=now,
            )
            if due:
                due_editions.append(ed)
            else:
                logger.info("cron.cadence.not_due", edition=str(ed.get("id")), reason=reason)

        enqueued: list[str] = []
        skipped: list[dict[str, Any]] = []
        for edition in due_editions:
            edition_id = edition.get("id")
            user_id = edition.get("user_id")
            send_date = datetime.now(UTC).date().isoformat()
            try:
                driver = _make_saga_driver()
                eid = await driver.start(
                    cfg={
                        "edition_id": edition_id,
                        "send_date": send_date,
                        "user_id": user_id,
                        "max_stories": 5,
                    }
                )
                if app.state.arq_pool is not None:
                    await app.state.arq_pool.enqueue_job(
                        "advance_newsletter_saga", str(eid), _queue_name=QUEUE_HEAVY
                    )
                else:
                    await driver.advance(eid)
                enqueued.append(str(eid))
            except Exception as exc:
                skipped.append({"edition_id": edition_id, "error": str(exc)[:120]})

        return {
            "enqueued": len(enqueued),
            "skipped": len(skipped),
            "execution_ids": enqueued,
            "errors": skipped,
        }

    @app.post("/cron/newsletter-cadence")
    async def cron_cadence(request: Request) -> dict[str, Any]:
        """Cadence cron — find editions whose interval has elapsed and enqueue a generate per edition.

        Auth: ``X-Cron-Secret`` (separate from the service-shared-secret because cron triggers live
        on a different schedule). The engine now also runs this on its own timer — see
        ``CADENCE_POLL_SECONDS`` — so this route is the manual kick, not the only driver.
        """
        _require_cron_secret(request)
        return await _cadence_tick()

    async def _ingestion_tick(max_items: int | None = None, feed_id: str = "") -> dict[str, Any]:
        """Enqueue one ingestion run on the heavy queue (E1).

        Enqueued rather than run inline: a tick walks every due feed and each item can cost a
        Firecrawl scrape plus two LLM calls, which has no business happening inside the process that
        serves the API. Going through arq also gives it the DLQ, the retry policy and the run ledger
        that every other engine job has.

        Falls back to running in-process when there is no arq pool — the same fallback the saga
        driver uses, so a Redis-less local stack still ingests.
        """
        body: dict[str, Any] = {"op": "feed" if feed_id else "run"}
        if feed_id:
            body["feed_id"] = feed_id
        if max_items:
            body["max_items"] = int(max_items)
        body["limit"] = get_settings().ingestion_feed_limit

        if app.state.arq_pool is not None:
            job = await app.state.arq_pool.enqueue_job(
                "run_write_tool_job", "ingestion", body, _queue_name=queue_for("ingestion", body["op"])
            )
            return {"enqueued": True, "job_id": getattr(job, "job_id", None), "body": body}

        from writer_engine.ingestion import ingest_due_feeds, ingest_feed
        from writer_engine.ingestion.store import get_feed

        if feed_id:
            feed = await get_feed(feed_id)
            results = [await ingest_feed(feed, max_items=max_items)] if feed else []
        else:
            results = await ingest_due_feeds(limit=body["limit"], max_items=max_items)
        return {
            "enqueued": False,
            "feeds": len(results),
            "items_uploaded": sum(r.items_uploaded for r in results),
            "errors": [{"feed": r.feed_name, "error": r.error} for r in results if r.error],
        }

    @app.post("/cron/ingestion")
    async def cron_ingestion(request: Request) -> dict[str, Any]:
        """Ingestion cron — poll the feed list and fill ``content_ingestion_v2`` (E1).

        The engine's replacement for ``AI News Data Ingestion V2`` and ``DEV - Newsletter Ingestion
        (Multi-User Cron)``. Auth: ``X-Cron-Secret``, same as the cadence cron.

        Optional query params: ``feed_id`` to re-run one feed regardless of its interval, and
        ``max_items`` to cap the per-feed item count for a cheap smoke test.
        """
        _require_cron_secret(request)
        raw_max = request.query_params.get("max_items") or ""
        return await _ingestion_tick(
            max_items=int(raw_max) if raw_max.isdigit() else None,
            feed_id=(request.query_params.get("feed_id") or "").strip(),
        )

    @app.get("/admin/scheduler", dependencies=[Depends(require_admin_token)])
    async def admin_scheduler() -> dict[str, Any]:
        """Is the engine's internal clock running, and did its last tick work? (E1)

        Worth an endpoint of its own: a scheduler that silently stopped looks identical to one with
        nothing to do, which is exactly how the n8n multi-user cron "succeeded" every 30 minutes for
        months while uploading nothing.
        """
        scheduler: Scheduler | None = getattr(app.state, "scheduler", None)
        if scheduler is None:
            return {"running": False, "reason": "no scheduled jobs enabled", "jobs": []}
        return {"running": True, **scheduler.status()}

    # Read by `lifespan`, which starts them once the app is up. Defined here because both jobs close
    # over `app.state` (the arq pool) and over the cadence body above.
    settings_for_jobs = get_settings()
    app.state.cron_jobs = [
        CronJob(
            name="ingestion",
            interval_s=settings_for_jobs.ingestion_poll_seconds,
            run=_ingestion_tick,
        ),
        CronJob(
            name="newsletter-cadence",
            interval_s=settings_for_jobs.cadence_poll_seconds,
            run=_cadence_tick,
        ),
    ]

    @app.get(
        "/pipelines/newsletter/executions/{execution_id}/review/{stage}",
        dependencies=[Depends(require_service_secret)],
    )
    async def newsletter_review(execution_id: str, stage: str) -> dict[str, Any]:
        """Return the review payload the UI's ApprovalDetail page should render at each gate.

        Replaces the six n8n ``share_*_email`` notifications: the UI fetches this when it sees
        ``status=awaiting_<stage>_approval`` and uses the payload to render the operator's review screen. Source
        of truth is the saga state — guaranteed consistent with whatever the orchestrator just persisted.
        """
        from fastapi import HTTPException
        from fastapi import status as http_status

        try:
            saga_state = await app.state.saga_repo.load(UUID(execution_id))
        except KeyError as exc:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND, detail="execution not found"
            ) from exc

        st = saga_state.state
        stage_norm = stage.lower().strip()

        if stage_norm in ("stories", "awaiting_stories_approval"):
            picked = st.get("picked")
            if picked is None:
                raise HTTPException(
                    status_code=http_status.HTTP_409_CONFLICT, detail="not yet at stories gate"
                )
            return {
                "stage": "awaiting_stories_approval",
                "execution_id": execution_id,
                "title": "Review selected stories",
                "token": st.get("stories_gate_token"),
                "selected_stories": picked.get("top_selected_stories") or [],
                "chain_of_thought": picked.get("chain_of_thought") or "",
                "revision_count": (st.get("revision_counts") or {}).get("stories", 0),
            }

        if stage_norm in ("subject", "awaiting_subject_approval"):
            subj = st.get("subject_proposal")
            if subj is None:
                raise HTTPException(
                    status_code=http_status.HTTP_409_CONFLICT, detail="not yet at subject gate"
                )
            return {
                "stage": "awaiting_subject_approval",
                "execution_id": execution_id,
                "title": "Review subject line",
                "token": st.get("subject_gate_token"),
                "subject_line": subj.get("subject_line"),
                "pre_header_text": subj.get("pre_header_text"),
                "additional_subject_lines": subj.get("additional_subject_lines") or [],
                "subject_line_reasoning": subj.get("subject_line_reasoning") or "",
                "pre_header_text_reasoning": subj.get("pre_header_text_reasoning") or "",
                "revision_count": (st.get("revision_counts") or {}).get("subject", 0),
            }

        if stage_norm in ("images", "image", "awaiting_image_approval"):
            options = st.get("image_options_by_story") or []
            segments = st.get("segments_data") or []
            if not options and not segments:
                raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail="not yet at image gate")
            # Combine: each story carries title + image options + the segment preview.
            stories: list[dict[str, Any]] = []
            for opts, seg in zip(options, segments, strict=False):
                stories.append(
                    {
                        "story_title": opts.get("story_title") or seg.get("story_title"),
                        "image_options": opts.get("options") or [],
                        "auto_pick": opts.get("auto_pick"),
                        "segment_preview": (seg.get("newsletter_section_content") or "")[:400],
                    }
                )
            return {
                "stage": "awaiting_image_approval",
                "execution_id": execution_id,
                "title": "Review images",
                "token": st.get("image_gate_token"),
                "stories": stories,
            }

        if stage_norm in ("final", "preview", "saved"):
            return {
                "stage": "saved",
                "execution_id": execution_id,
                "title": "Final newsletter preview",
                "send_row": st.get("send_row") or {},
                "delivery": st.get("delivery") or {},
                "permalink": st.get("permalink_placeholder"),
            }

        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"unknown review stage '{stage}' (expected: stories|subject|images|final)",
        )

    return app


app = build_app()
