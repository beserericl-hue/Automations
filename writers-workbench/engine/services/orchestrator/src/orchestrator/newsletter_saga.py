"""Durable newsletter saga — per-stage methods + an ``advance()`` driver.

This complements the synchronous :class:`orchestrator.newsletter_orch.NewsletterOrchestrator` (still used by the
in-process E2E test). Where the sync orchestrator runs the whole pipeline inline holding local variables, this
saga persists *every* between-stage value to a :class:`writer_engine.state_machine.durable.SagaStateRepo` so a
worker crash, restart, or HITL pause does not lose the run.

Flow per call to :meth:`advance`:

1. Load :class:`ExecutionState` from the repo by ``execution_id``.
2. Run the handler for the current stage. The handler reads from / writes to ``state.state`` and updates ``stage``.
3. Repeat until the saga reaches a pause-stage (an ``awaiting_*_approval`` Stage) or a terminal stage.
4. Return ``SagaResult`` so the caller (arq worker or HTTP endpoint) knows whether to enqueue a follow-up.

The :func:`enqueue_advance` hook lets a real arq worker schedule the next ``advance`` call; tests pass ``None``
and just rely on the loop in :meth:`advance` to drive through the stages within one process tick.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from writer_engine.config import get_settings
from writer_engine.newsletter_issue import peek_issue_number, saved_issue_number
from writer_engine.schemas import Stage, StepOutput, StepStatus
from writer_engine.schemas.newsletter import (
    AssembledNewsletter,
    DeliveryResult,
    NewsletterSendRow,
    PickedStories,
    RenderedNewsletter,
    SubjectLineProposal,
)
from writer_engine.state_machine.durable import SagaStateRepo
from writer_engine.state_machine.hitl import ApprovalDecision, create_approval
from writer_engine.state_machine.progress import emit_progress
from writer_engine.state_machine.saga import StepRef, run_step_via_http
from writer_engine.state_machine.workbench_callback import notify_workbench_stage
from writer_engine.telemetry.logging import get_logger

logger = get_logger("newsletter_saga")


async def _studio_selection(cfg: dict[str, Any], execution_id: UUID) -> list[dict[str, Any]] | None:
    """The stories chosen in the Content Studio for this edition's issue, or None (then gather + pick).

    A failure to READ the selection fails the run rather than quietly publishing an LLM pick the owner
    did not choose; no Supabase (local demo) means no selection.
    """
    settings = get_settings()
    if not (cfg.get("edition_id") and settings.supabase_url and settings.supabase_service_role_key):
        return None
    from writer_engine.studio.issue import take_selection
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    return await take_selection(
        client,
        user_id=str(cfg.get("user_id") or ""),
        edition_id=str(cfg.get("edition_id") or ""),
        send_date=str(cfg.get("send_date") or ""),
        execution_id=str(execution_id),
    )


DEFAULT_PORTS = {
    "gather": 8010,
    "pick": 8011,
    "subject": 8012,
    "scrape": 8013,
    "segment": 8014,
    "image": 8015,
    "assemble": 8016,
    "render": 8017,
    "persist": 8018,
    "deliver": 8019,
}

MAX_REVISIONS_PER_GATE = 2

PAUSE_STAGES = {
    Stage.AWAITING_STORIES_APPROVAL,
    Stage.AWAITING_SUBJECT_APPROVAL,
    Stage.AWAITING_IMAGE_APPROVAL,
}
TERMINAL_STAGES = {Stage.SENT, Stage.SCHEDULED, Stage.SKIPPED_NO_CONTENT, Stage.ERROR}


class SagaResult(str, Enum):
    PAUSED = "paused"  # waiting on a HITL gate
    DONE = "done"  # reached SENT/SCHEDULED/SKIPPED_NO_CONTENT
    ERROR = "error"


def _step(name: str) -> StepRef:
    env = f"{name.upper()}_STEP_URL"
    return StepRef(
        name=name, url=os.environ.get(env, f"http://{name.replace('_', '-')}-step:{DEFAULT_PORTS[name]}")
    )


EnqueueHook = Callable[[UUID], Awaitable[None]] | None


def _humanize_budget_left(segments: list[dict[str, Any]]) -> int | None:
    """HUMANIZE_MAX_WORDS_PER_RUN minus what this newsletter's sections have already billed."""
    ceiling = int(get_settings().humanize_max_words_per_run or 0)
    if ceiling <= 0:
        return None
    spent = sum(int((seg.get("humanize") or {}).get("words_spent") or 0) for seg in segments)
    return max(0, ceiling - spent)


def _humanize_summary(segments: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-section humanize outcome for the send row's metadata ({} when the pass never ran)."""
    ran = [
        (seg.get("story_title"), seg["humanize"]) for seg in segments if isinstance(seg.get("humanize"), dict)
    ]
    if not ran:
        return {}
    return {
        "humanize": {
            "applied": any(r.get("applied") for _, r in ran),
            "words_spent": sum(int(r.get("words_spent") or 0) for _, r in ran),
            "sections": [
                {
                    "story_title": title,
                    "applied": bool(r.get("applied")),
                    "chunks": r.get("chunks"),
                    "humanized_chunks": r.get("humanized_chunks"),
                    "rejected": r.get("rejected"),
                    "rejected_layout": r.get("rejected_layout"),
                    "retried": r.get("retried"),
                    "words_spent": r.get("words_spent"),
                    "skipped": r.get("skipped"),
                }
                for title, r in ran
            ],
        }
    }


def newsletter_accounting(st: dict[str, Any]) -> dict[str, Any]:
    """The ``accounting`` block for a newsletter step: who pays, and which edition/send it was."""
    cfg = st.get("cfg") or {}
    meta: dict[str, Any] = {"pipeline": "newsletter"}
    for key in ("edition_id", "send_date"):
        if cfg.get(key):
            meta[key] = str(cfg[key])
    send_id = (st.get("send_row") or {}).get("id")
    if send_id:
        meta["send_id"] = str(send_id)
    return {"user_id": str(cfg.get("user_id") or "") or None, "metadata": meta}


class NewsletterSagaDriver:
    """Durable newsletter saga. Stateless; all state lives in :class:`SagaStateRepo`."""

    pipeline_name = "newsletter"

    def __init__(self, repo: SagaStateRepo, *, enqueue_advance: EnqueueHook = None) -> None:
        self._repo = repo
        self._enqueue_advance = enqueue_advance

    # ---------- lifecycle ----------

    async def start(self, *, cfg: dict[str, Any], execution_id: UUID | None = None) -> UUID:
        """Create the execution row and emit INIT. Caller then enqueues advance(execution_id)."""
        eid = execution_id or uuid4()
        await self._repo.create(
            execution_id=eid,
            pipeline=self.pipeline_name,
            initial_state={"cfg": cfg, "revision_counts": {"stories": 0, "subject": 0, "image": 0}},
        )
        await emit_progress(eid, Stage.INIT, message="newsletter saga started")
        return eid

    async def advance(self, execution_id: UUID) -> SagaResult:
        """Run as many stages as possible. Returns when a gate pauses or a terminal stage is reached.

        Each iteration: load state, check for terminal/pause stages, otherwise dispatch the handler for the
        current stage. Handlers update ``state.stage`` via ``_advance()``; the loop simply re-reads the state.
        Safety: hard-cap the loop at ``MAX_STAGES_PER_CALL`` so a misconfigured saga can't spin forever.
        """
        MAX_STAGES_PER_CALL = 20
        for _ in range(MAX_STAGES_PER_CALL):
            state = await self._repo.load(execution_id)
            if state.stage in TERMINAL_STAGES:
                return SagaResult.DONE if state.stage is not Stage.ERROR else SagaResult.ERROR
            if state.stage in PAUSE_STAGES:
                return SagaResult.PAUSED
            try:
                await self._run_stage(execution_id, state.stage, state.state)
            except Exception as exc:  # noqa: BLE001 - saga error boundary: any stage failure is recorded as Stage.ERROR and shown to the user
                await self._repo.update(
                    execution_id,
                    stage=Stage.ERROR,
                    status=StepStatus.ERROR,
                    error={"code": type(exc).__name__, "message": str(exc)[:300]},  # type: ignore[arg-type]
                )
                await emit_progress(execution_id, Stage.ERROR, message=str(exc)[:300])
                return SagaResult.ERROR
        # Hit the safety cap without reaching a terminal/pause stage — surface as error.
        await self._repo.update(
            execution_id,
            stage=Stage.ERROR,
            status=StepStatus.ERROR,
            error={
                "code": "MAX_STAGES_EXCEEDED",
                "message": "saga did not terminate within MAX_STAGES_PER_CALL",
            },  # type: ignore[arg-type]
        )
        return SagaResult.ERROR

    async def resume(self, execution_id: UUID) -> SagaResult:
        """Called by the resolve endpoint after a gate has been decided. Just delegates to advance."""
        return await self.advance(execution_id)

    # ---------- stage dispatch ----------

    async def _run_stage(self, execution_id: UUID, stage: Stage, st: dict[str, Any]) -> None:
        handler = self._HANDLERS.get(stage, NewsletterSagaDriver._stage_init)  # type: ignore[attr-defined]
        await handler(self, execution_id, st)

    # ---------- stage handlers ----------

    async def _stage_init(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        await self._advance(execution_id, Stage.GATHERING, "gathering ingested articles")
        return Stage.GATHERING

    async def _stage_gathering(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        cfg = st["cfg"]
        # Content Studio: the owner chose this issue's stories. Then those, in that order, ARE the
        # issue — no week-pool gather, no LLM pick (writer_engine.studio.issue).
        chosen = await _studio_selection(cfg, execution_id)
        if chosen:
            await self._advance(
                execution_id,
                Stage.PICKING,
                f"using the {len(chosen)} stories chosen in the Content Studio",
                patch={"articles": chosen, "studio_selection": True},
            )
            return Stage.PICKING
        out = await self._run_step(
            st,
            _step("gather"),
            execution_id=execution_id,
            payload={
                "send_date": cfg.get("send_date", ""),
                "user_id": cfg.get("user_id", ""),
                # Gather reads only this edition's own sources, over its cadence's window.
                "edition_id": cfg.get("edition_id", ""),
                "limit": 50,
            },
        )
        articles = list(out.payload.get("articles") or [])
        if not articles:
            await self._advance(execution_id, Stage.SKIPPED_NO_CONTENT, "no ingested content for date")
            return None
        await self._advance(execution_id, Stage.PICKING, "picking top stories", patch={"articles": articles})
        return Stage.PICKING

    async def _stage_picking(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        articles = st["articles"]
        cfg = st["cfg"]
        feedback = st.get("pick_feedback")
        if st.get("studio_selection"):
            from writer_engine.studio.issue import picked_from_selection

            chosen = PickedStories.model_validate(picked_from_selection(articles))
            gate = await create_approval(
                execution_id=execution_id,
                stage="awaiting_stories_approval",
                payload=chosen.model_dump(mode="json"),
                user_id=cfg.get("user_id") or None,
                edition_id=cfg.get("edition_id") or None,
            )
            await self._advance(
                execution_id,
                Stage.AWAITING_STORIES_APPROVAL,
                "awaiting stories approval",
                patch={"picked": chosen.model_dump(mode="json"), "stories_gate_token": gate.token},
            )
            return None
        out = await self._run_step(
            st,
            _step("pick"),
            execution_id=execution_id,
            payload={
                "articles": articles,
                "max_stories": int(cfg.get("max_stories", 5)),
                "feedback": feedback,
                # Edition theme — the picker uses this to select on-topic stories instead of
                # defaulting to a generic "technical reader" audience.
                "genre": cfg.get("genre") or None,
                "newsletter_name": cfg.get("newsletter_name") or None,
            },
            timeout_s=240.0,  # LLM story selection can exceed the 60s default
        )
        if out.status is StepStatus.ERROR:
            raise RuntimeError(f"pick step error: {out.error}")
        picked = PickedStories.model_validate(out.payload)
        gate = await create_approval(
            execution_id=execution_id,
            stage="awaiting_stories_approval",
            payload=picked.model_dump(mode="json"),
            user_id=cfg.get("user_id") or None,
            edition_id=cfg.get("edition_id") or None,
        )
        await self._advance(
            execution_id,
            Stage.AWAITING_STORIES_APPROVAL,
            "awaiting stories approval",
            patch={"picked": picked.model_dump(mode="json"), "stories_gate_token": gate.token},
        )
        return None  # paused; resolve will resume

    async def _stage_stories_approved(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        await self._advance(execution_id, Stage.SUBJECT, "writing subject line")
        return Stage.SUBJECT

    async def _stage_subject(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        picked = PickedStories.model_validate(st["picked"])
        feedback = st.get("subject_feedback")
        out = await self._run_step(
            st,
            _step("subject"),
            execution_id=execution_id,
            payload={
                "top_selected_stories": [s.model_dump(mode="json") for s in picked.top_selected_stories],
                "feedback": feedback,
                # A2: the real n8n subject brief also reads the day's corpus + the date.
                "articles": st.get("articles") or [],
                "newsletter_date": str((st.get("cfg") or {}).get("send_date") or ""),
            },
            timeout_s=240.0,  # LLM subject-line generation can exceed the 60s default
        )
        if out.status is StepStatus.ERROR:
            raise RuntimeError(f"subject step error: {out.error}")
        proposal = SubjectLineProposal.model_validate(out.payload)
        gate = await create_approval(
            execution_id=execution_id,
            stage="awaiting_subject_approval",
            payload=proposal.model_dump(mode="json"),
            user_id=st["cfg"].get("user_id") or None,
            edition_id=st["cfg"].get("edition_id") or None,
        )
        await self._advance(
            execution_id,
            Stage.AWAITING_SUBJECT_APPROVAL,
            "awaiting subject approval",
            patch={"subject_proposal": proposal.model_dump(mode="json"), "subject_gate_token": gate.token},
        )
        return None

    async def _stage_subject_approved(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        await self._advance(execution_id, Stage.WRITING_SEGMENTS, "writing segments")
        return Stage.WRITING_SEGMENTS

    async def _stage_writing_segments(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        articles = st["articles"]
        picked = PickedStories.model_validate(st["picked"])
        subj = st.get("subject_proposal") or {}
        segments_data: list[dict[str, Any]] = []
        image_options_by_story: list[dict[str, Any]] = []

        for story in picked.top_selected_stories:
            story_payload = story.model_dump(mode="json")
            sources = [a for a in articles if a.get("id") in story.identifiers]
            # Scrape supplemental URLs. TRULY non-fatal: run_step_via_http RAISES on a timeout / 5xx
            # (it does not return an ERROR status), so a slow or dead external URL — e.g. a survivalist
            # blog that hangs — would otherwise crash the whole stage and the newsletter would never
            # send. Catch everything here and degrade to no scraped content. The scrape step fetches a
            # story's URLs side by side and cuts each off at 120s (ScraperAPI alone can spend 70s on
            # one hard page), so 180s covers the step with room for the hop.
            try:
                scrape_out = await self._run_step(
                    st,
                    _step("scrape"),
                    execution_id=execution_id,
                    payload={"urls": story.external_source_links},
                    timeout_s=180.0,
                )
                scraped = (
                    [] if scrape_out.status is StepStatus.ERROR else (scrape_out.payload.get("scraped") or [])
                )
            except Exception as exc:  # noqa: BLE001 - a scrape failure must not fail the edition; logged (C4)
                # C4: this was a bare `scraped = []`, so a scrape step that threw produced an
                # edition built from headlines alone and looked exactly like a story with no
                # external links. The send still goes out — one story's sources are not worth
                # failing an edition over — but it no longer goes out quietly.
                logger.warning(
                    "saga.scrape_failed",
                    execution_id=str(execution_id),
                    urls=len(story.external_source_links or []),
                    error=f"{type(exc).__name__}: {exc}"[:160],
                )
                scraped = []
            # Image + segment are LLM-backed and routinely exceed the 60s default; give them headroom so
            # a normal-latency generation isn't misread as a timeout — a raised timeout here aborts the
            # whole run (advance() moves the saga to ERROR), which was silently killing sends on DEV.
            image_out = await self._run_step(
                st,
                _step("image"),
                execution_id=execution_id,
                payload={"story": story_payload, "scraped_images": []},
                timeout_s=240.0,
            )
            if image_out.status is StepStatus.ERROR:
                raise RuntimeError(f"image step error for {story.title!r}: {image_out.error}")
            image_options_by_story.append(image_out.payload)
            seg_out = await self._run_step(
                st,
                _step("segment"),
                execution_id=execution_id,
                payload={
                    "story": story_payload,
                    "sources": sources + scraped,
                    "image_options": image_out.payload.get("options") or [],
                    # A2: the real n8n segment brief writes each section against the chosen subject
                    # line / pre-header so the sections and the subject stay on one angle.
                    "subject_line": subj.get("subject_line", ""),
                    "pre_header": subj.get("pre_header_text", ""),
                    "newsletter_date": str((st.get("cfg") or {}).get("send_date") or ""),
                    # E6: what is left of the newsletter's humanize ceiling, so the per-run cap holds
                    # across all its sections rather than per section. None = no ceiling configured.
                    "humanize_budget_words": _humanize_budget_left(segments_data),
                    # The edition's theme, so a non-AI edition's sections are written about their
                    # own subject instead of refused against the AI-newsletter brief.
                    "genre": (st.get("cfg") or {}).get("genre") or None,
                    "newsletter_name": (st.get("cfg") or {}).get("newsletter_name") or None,
                    **({"humanize": False} if (st.get("cfg") or {}).get("humanize") is False else {}),
                },
                timeout_s=240.0,
            )
            # A failed segment must abort the run — silently appending the empty error payload
            # produced a blank newsletter body (5 empty segments) on an earlier DEV run.
            if seg_out.status is StepStatus.ERROR:
                raise RuntimeError(f"segment step error for {story.title!r}: {seg_out.error}")
            segments_data.append(seg_out.payload)

        await self._advance(
            execution_id,
            Stage.PROPOSING_IMAGES,
            "proposing image options",
            patch={"segments_data": segments_data, "image_options_by_story": image_options_by_story},
        )
        return Stage.PROPOSING_IMAGES

    async def _stage_proposing_images(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        gate = await create_approval(
            execution_id=execution_id,
            stage="awaiting_image_approval",
            payload={
                "image_options_by_story": st.get("image_options_by_story") or [],
                "segments": st.get("segments_data") or [],
            },
            user_id=st["cfg"].get("user_id") or None,
            edition_id=st["cfg"].get("edition_id") or None,
        )
        await self._advance(
            execution_id,
            Stage.AWAITING_IMAGE_APPROVAL,
            "awaiting image approval",
            patch={"image_gate_token": gate.token},
        )
        return None

    async def _stage_images_approved(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        chosen = dict(st.get("chosen_images") or {})
        segments = list(st.get("segments_data") or [])
        for seg in segments:
            title = seg.get("story_title")
            if title in chosen:
                seg["chosen_image_url"] = chosen[title]
        await self._advance(
            execution_id,
            Stage.ASSEMBLING,
            "assembling full newsletter",
            patch={"segments_data": segments},
        )
        return Stage.ASSEMBLING

    async def _stage_assembling(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        picked = PickedStories.model_validate(st["picked"])
        used_ids = {i for s in picked.top_selected_stories for i in s.identifiers}
        remaining = [a for a in st.get("articles", []) if a.get("id") not in used_ids]
        out = await self._run_step(
            st,
            _step("assemble"),
            execution_id=execution_id,
            payload={
                "segments": st.get("segments_data") or [],
                "remaining_items": remaining,
                # A2: the intro + roundup briefs read the subject line and the date.
                "subject_line": (st.get("subject_proposal") or {}).get("subject_line", ""),
                "pre_header": (st.get("subject_proposal") or {}).get("pre_header_text", ""),
                "newsletter_date": str((st.get("cfg") or {}).get("send_date") or ""),
            },
            timeout_s=240.0,  # LLM intro + roundup composition can exceed the 60s default
        )
        assembled = AssembledNewsletter.model_validate(out.payload)
        await self._advance(
            execution_id,
            Stage.RENDERING,
            "rendering HTML",
            patch={"assembled": assembled.model_dump(mode="json")},
        )
        return Stage.RENDERING

    async def _stage_rendering(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        cfg = st["cfg"]
        subj = SubjectLineProposal.model_validate(st["subject_proposal"])
        assembled = AssembledNewsletter.model_validate(st["assembled"])
        edition_id = str(cfg.get("edition_id") or "")
        send_date = str(cfg.get("send_date") or "")
        # The "view in browser" permalink points at the Workbench view route, which serves the
        # stored html_body as text/html. (Supabase Storage force-serves user HTML as text/plain, so
        # a storage URL never renders in a browser.) Fall back to the storage URL only if WW isn't
        # configured.
        ww_base = os.environ.get("WORKBENCH_API_URL", "").rstrip("/")
        if ww_base:
            permalink_placeholder = f"{ww_base}/api/newsletter/view/{edition_id}/{send_date}"
        else:
            send_id_str = f"{edition_id}-{send_date}"
            permalink_placeholder = (
                f"{os.environ.get('ARCHIVE_BASE_URL', '').rstrip('/')}/{edition_id}/{send_id_str}.html"
            )
        render_payload: dict[str, Any] = {
            "edition_id": edition_id,
            "subject": subj.subject_line,
            "pre_header_text": subj.pre_header_text,
            # Masthead comes from the edition (newsletter_name), not a hardcoded default, so a
            # themed edition (e.g. "The Wasteland Wire") isn't rendered as "The Workbench".
            "masthead": cfg.get("newsletter_name") or "The Workbench",
            "markdown_body": assembled.markdown_body,
            "permalink_url": permalink_placeholder,
            "send_date": send_date,
        }
        story_ids = [s.identifiers for s in PickedStories.model_validate(st["picked"]).top_selected_stories]
        humanize_meta = _humanize_summary(st.get("segments_data") or [])

        async def _render_and_persist(number: int | None) -> tuple[RenderedNewsletter, dict[str, Any]]:
            out = await self._run_step(
                st,
                _step("render"),
                execution_id=execution_id,
                payload={**render_payload, "issue_number": number},
                timeout_s=180.0,  # Handlebars render via the Workbench HTTP endpoint — headroom over 60s
            )
            rendered = RenderedNewsletter.model_validate(out.payload)
            row = NewsletterSendRow(
                user_id=str(cfg.get("user_id") or ""),
                edition_id=edition_id,
                send_date=send_date,
                subject=subj.subject_line,
                pre_header_text=subj.pre_header_text,
                markdown_body=assembled.markdown_body,
                html_body=rendered.html_body,
                status="saved",
                issue_number=number,
                metadata={
                    "selected_story_identifiers": story_ids,
                    "subject_reasoning": subj.subject_line_reasoning,
                    **humanize_meta,
                },
            )
            persist_out = await self._run_step(
                st,
                _step("persist"),
                execution_id=execution_id,
                payload={"row": row.model_dump(mode="json")},
                # A re-render must re-save: one key per number, or the idempotency cache would hand
                # back the first save and keep the stale HTML.
                idempotency_key=f"{execution_id}:persist:{number}",
            )
            return rendered, dict(persist_out.payload.get("send_row") or {})

        # Issue number: the database assigns it on save (migration 041), but the email prints it, so
        # ask for the number this save will get, render with it, and propose it on the save.
        issue_number = await peek_issue_number(edition_id, send_date)
        rendered, send_row_saved = await _render_and_persist(issue_number)
        saved_number = saved_issue_number(send_row_saved)
        if saved_number is not None and saved_number != issue_number:
            # Another send of this edition took the peeked number between the peek and the save, so
            # the trigger gave this one the next free number. Re-render so the email matches the row.
            logger.info(
                "saga.issue_number_reassigned",
                execution_id=str(execution_id),
                peeked=issue_number,
                saved=saved_number,
            )
            rendered, send_row_saved = await _render_and_persist(saved_number)
        await self._advance(
            execution_id,
            Stage.SAVED,
            "send row saved",
            patch={
                "rendered_html": rendered.html_body,
                "send_row": send_row_saved,
                "permalink_placeholder": permalink_placeholder,
            },
        )
        return Stage.SAVED

    async def _stage_saved(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        await self._advance(execution_id, Stage.SENDING, "delivering to subscribers + publishing permalink")
        return Stage.SENDING

    async def _stage_sending(self, execution_id: UUID, st: dict[str, Any]) -> Stage | None:
        cfg = st["cfg"]
        subj = SubjectLineProposal.model_validate(st["subject_proposal"])
        send_row = st.get("send_row") or {}
        send_id = send_row.get("id") or f"{cfg.get('edition_id', '')}-{cfg.get('send_date', '')}"
        out = await self._run_step(
            st,
            _step("deliver"),
            execution_id=execution_id,
            payload={
                "edition_id": cfg.get("edition_id", ""),
                "send_id": send_id,
                "html_body": st.get("rendered_html", ""),
                "subject": subj.subject_line,
                "permalink_url": st.get("permalink_placeholder", ""),
            },
            timeout_s=240.0,  # Postal delivery fans out one email per subscriber — headroom over 60s
        )
        delivery = DeliveryResult.model_validate(out.payload)
        await self._advance(
            execution_id,
            Stage.SENT,
            f"sent to {delivery.recipients_emailed}; permalink {delivery.permalink_url}",
            patch={"delivery": delivery.model_dump(mode="json")},
        )
        return None

    # ---------- helpers ----------

    async def _run_step(
        self,
        st: dict[str, Any],
        step: StepRef,
        *,
        execution_id: UUID,
        payload: dict[str, Any],
        idempotency_key: str | None = None,
        timeout_s: float = 60.0,
    ) -> StepOutput:
        """Call a step with the edition owner attached for cost accounting.

        Every paid call a newsletter step makes is written to ``token_usage_v2`` by the step template,
        which takes the owner from the payload. The saga sent no user, so every pick / subject /
        segment / humanize / intro row was written with ``user_id`` NULL. The run id stays the
        execution id (the template's default), which ties the rows to this send.
        """
        return await run_step_via_http(
            step,
            execution_id=execution_id,
            payload={**payload, "accounting": newsletter_accounting(st)},
            idempotency_key=idempotency_key,
            timeout_s=timeout_s,
        )

    async def _advance(
        self,
        execution_id: UUID,
        next_stage: Stage,
        message: str,
        *,
        patch: dict[str, Any] | None = None,
    ) -> None:
        await self._repo.update(execution_id, stage=next_stage, patch=patch)
        await emit_progress(execution_id, next_stage, message=message)
        # F2-8: best-effort mirror of the stage to the WW per-user SSE channel (no-op when the
        # callback secret / workbench URL aren't configured). Never fails the saga.
        try:
            state = await self._repo.load(execution_id)
            await notify_workbench_stage(
                execution_id, next_stage.value, cfg=state.state.get("cfg"), message=message
            )
        except Exception as exc:  # noqa: BLE001 - the stage callback is advisory; the stage is already persisted above
            logger.warning(
                "saga.stage_callback_failed",
                execution_id=str(execution_id),
                stage=next_stage.value,
                error=f"{type(exc).__name__}: {exc}"[:160],
            )

    # ---------- resolve hook ----------

    async def apply_decision(
        self,
        execution_id: UUID,
        *,
        gate_stage: str,
        decision: ApprovalDecision,
        feedback: str | None,
        chosen_images: dict[str, str] | None = None,
    ) -> None:
        """Translate a HITL decision into a state transition. Called by the resolve endpoint."""
        state = await self._repo.load(execution_id)
        revcounts = dict(state.state.get("revision_counts") or {})

        if gate_stage == "awaiting_stories_approval":
            if decision is ApprovalDecision.APPROVE:
                await self._advance(execution_id, Stage.STORIES_APPROVED, "stories approved")
            elif decision is ApprovalDecision.REVISE and revcounts.get("stories", 0) < MAX_REVISIONS_PER_GATE:
                revcounts["stories"] = revcounts.get("stories", 0) + 1
                await self._advance(
                    execution_id,
                    Stage.PICKING,
                    "revising story selection",
                    patch={"pick_feedback": feedback or "", "revision_counts": revcounts},
                )
            else:
                await self._advance(execution_id, Stage.ERROR, "stories rejected or max revisions hit")
        elif gate_stage == "awaiting_subject_approval":
            if decision is ApprovalDecision.APPROVE:
                await self._advance(execution_id, Stage.SUBJECT_APPROVED, "subject approved")
            elif decision is ApprovalDecision.REVISE and revcounts.get("subject", 0) < MAX_REVISIONS_PER_GATE:
                revcounts["subject"] = revcounts.get("subject", 0) + 1
                await self._advance(
                    execution_id,
                    Stage.SUBJECT,
                    "revising subject line",
                    patch={"subject_feedback": feedback or "", "revision_counts": revcounts},
                )
            else:
                await self._advance(execution_id, Stage.ERROR, "subject rejected or max revisions hit")
        elif gate_stage == "awaiting_image_approval":
            if decision is ApprovalDecision.APPROVE:
                await self._advance(
                    execution_id,
                    Stage.IMAGES_APPROVED,
                    "images approved",
                    patch={"chosen_images": chosen_images or {}},
                )
            else:
                await self._advance(execution_id, Stage.ERROR, "images rejected")
        else:
            raise ValueError(f"unknown gate stage: {gate_stage}")

        if self._enqueue_advance is not None:
            await self._enqueue_advance(execution_id)


# Dispatch table — defined after the class so methods are bound names.
NewsletterSagaDriver._HANDLERS = {  # type: ignore[attr-defined]
    Stage.INIT: NewsletterSagaDriver._stage_init,
    Stage.GATHERING: NewsletterSagaDriver._stage_gathering,
    Stage.PICKING: NewsletterSagaDriver._stage_picking,
    Stage.STORIES_APPROVED: NewsletterSagaDriver._stage_stories_approved,
    Stage.SUBJECT: NewsletterSagaDriver._stage_subject,
    Stage.SUBJECT_APPROVED: NewsletterSagaDriver._stage_subject_approved,
    Stage.WRITING_SEGMENTS: NewsletterSagaDriver._stage_writing_segments,
    Stage.PROPOSING_IMAGES: NewsletterSagaDriver._stage_proposing_images,
    Stage.IMAGES_APPROVED: NewsletterSagaDriver._stage_images_approved,
    Stage.ASSEMBLING: NewsletterSagaDriver._stage_assembling,
    Stage.RENDERING: NewsletterSagaDriver._stage_rendering,
    Stage.SAVED: NewsletterSagaDriver._stage_saved,
    Stage.SENDING: NewsletterSagaDriver._stage_sending,
}
