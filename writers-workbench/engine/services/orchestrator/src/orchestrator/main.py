"""Orchestrator FastAPI app — runs a pipeline synchronously for F0 vertical slice.

Long-running pipelines (newsletter, chapter) switch to arq enqueue in F2/F1 — same handler, different transport.
"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID, uuid4

from arq import create_pool
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi import status as http_status

from writer_engine.auth import require_service_secret
from writer_engine.config import get_settings
from writer_engine.redis_client.client import close_redis
from writer_engine.state_machine.durable import RedisSagaRepo
from writer_engine.state_machine.orchestrator import InMemoryStateStore
from writer_engine.state_machine.saga import StepRef, run_step_via_http
from writer_engine.telemetry.logging import configure_logging, get_logger
from writer_engine.telemetry.metrics import HTTP_LATENCY, HTTP_REQUESTS, metrics_app, observe_latency

from .library_orch import LibraryRetrieveOrchestrator
from .newsletter_orch import NewsletterOrchestrator
from .newsletter_saga import NewsletterSagaDriver
from .worker import build_redis_settings

# When set, the durable saga driver enqueues advance via this arq pool. Tests set it to None and drive
# advance() directly so they don't need a live Redis + arq worker.
_arq_pool = None

SERVICE = "orchestrator"

# F1-B write-workshop tools the hub can dispatch to (tool name == step STEP_NAME). Values pull the
# step URL from settings at call time so env overrides apply.
_WRITE_TOOL_URLS: dict[str, Callable[[Any], str]] = {
    "chapter": lambda s: s.chapter_step_url,
    "research": lambda s: s.research_step_url,
    "brainstorm": lambda s: s.brainstorm_step_url,
    "media": lambda s: s.media_step_url,
    "library": lambda s: s.library_step_url,
    "story_bible": lambda s: s.story_bible_step_url,
    "approval": lambda s: s.approval_step_url,
    "notify": lambda s: s.notify_step_url,
}


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
    try:
        yield
    finally:
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
                    "advance_newsletter_saga", str(execution_id), _queue_name="newsletter"
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
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": SERVICE}

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

    @app.post("/pipelines/write/{tool}/run", dependencies=[Depends(require_service_secret)])
    async def run_write_tool(tool: str, body: dict[str, Any]) -> dict[str, Any]:
        """F1-B: single-call dispatch to a write-workshop step (chapter/research/brainstorm/...).

        The n8n hub's ai_tool nodes POST here (via the gateway) instead of executeWorkflow. The body
        is the step payload ({op, ...}); the response is the StepOutput. The tool name must match the
        step service's STEP_NAME (so StepInput.step_name validates).
        """
        url = _WRITE_TOOL_URLS.get(tool)
        if url is None:
            raise HTTPException(http_status.HTTP_404_NOT_FOUND, detail=f"unknown write tool: {tool}")
        settings = get_settings()
        exec_id = body.get("execution_id")
        out = await run_step_via_http(
            StepRef(name=tool, url=url(settings)),
            execution_id=UUID(exec_id) if exec_id else uuid4(),
            payload=body,
            timeout_s=float(body.get("timeout_s") or 180.0),
        )
        return out.model_dump(mode="json")

    @app.get("/pipelines/{pipeline}/state/{execution_id}", dependencies=[Depends(require_service_secret)])
    async def get_state(pipeline: str, execution_id: str) -> dict[str, Any]:
        state = await app.state.store.load(UUID(execution_id))
        return state.model_dump(mode="json")

    @app.post("/pipelines/newsletter/run", dependencies=[Depends(require_service_secret)])
    async def run_newsletter(body: dict[str, Any]) -> dict[str, Any]:
        """Synchronous newsletter run — kept for the in-process E2E test (the auto-approve-hook path)."""
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
        }
        execution_id = await driver.start(cfg=cfg)
        # If arq is available, hand off to the worker; else drive inline so the response carries the first pause.
        if app.state.arq_pool is not None:
            await app.state.arq_pool.enqueue_job(
                "advance_newsletter_saga", str(execution_id), _queue_name="newsletter"
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

    @app.post("/cron/newsletter-cadence")
    async def cron_cadence(request: Request) -> dict[str, Any]:
        """Cadence cron — find editions whose ``next_scheduled_send_at <= now()`` and enqueue a generate per
        edition. Auth: ``X-Cron-Secret`` header (separate from the service-shared-secret because cron triggers
        live on a different schedule — Railway cron, cron-job.org, etc.)."""
        from fastapi import HTTPException
        from fastapi import status as http_status

        expected = (get_settings().admin_token or "").strip()
        provided = (request.headers.get("x-cron-secret") or "").strip()
        if not provided or provided != expected:
            raise HTTPException(http_status.HTTP_401_UNAUTHORIZED, detail="missing or invalid X-Cron-Secret")

        from datetime import UTC, datetime

        from writer_engine.supabase.client import get_supabase_admin

        try:
            client = await get_supabase_admin()
        except Exception:
            return {"enqueued": 0, "skipped_reason": "supabase not configured"}

        # "Due" is derived from cadence + the last send, mirroring the WW computeDueEditions path
        # (server/src/routes/newsletter-edition-extras.ts). newsletter_editions_v2 has no
        # next_scheduled_send_at/send_time/timezone columns — the only cadence columns are
        # `cadence` and `cadence_send_time`. Compute the interval here instead of an absent column.
        interval_days = {"daily": 1, "weekly": 7, "biweekly": 14, "monthly": 30}
        now = datetime.now(UTC)
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
            days = interval_days.get(str(ed.get("cadence") or ""))
            if not days:
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
            try:
                baseline = datetime.fromisoformat(str(baseline_iso).replace("Z", "+00:00"))
            except (ValueError, TypeError):
                due_editions.append(ed)
                continue
            if (now - baseline).total_seconds() / 86400.0 >= days:
                due_editions.append(ed)

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
                        "advance_newsletter_saga", str(eid), _queue_name="newsletter"
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
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="execution not found") from exc

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
