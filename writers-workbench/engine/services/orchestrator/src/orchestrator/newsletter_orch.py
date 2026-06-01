"""newsletter-orch — the saga that drives the F2 newsletter pipeline.

Lifecycle (durable state on ``newsletter_sends_v2``-equivalent row; in-memory in tests)::

    gathering -> picking -> awaiting_stories_approval -> stories_approved ->
    subject -> awaiting_subject_approval -> subject_approved ->
    writing_segments -> proposing_images -> awaiting_image_approval -> images_approved ->
    assembling -> rendering -> saved -> sending -> sent

Three HITL gates (stories, subject, images). On ``revise`` the orchestrator re-enqueues the relevant step
with the operator's feedback; on ``approve`` it advances. Per design decision #4 (true per-step
microservices), each step lives in its own service and is invoked via :func:`run_step_via_http`.
"""

from __future__ import annotations

import os
from typing import Any
from uuid import UUID

from writer_engine.schemas import Stage, StepStatus
from writer_engine.schemas.newsletter import (
    AssembledNewsletter,
    DeliveryResult,
    NewsletterSendRow,
    PickedStories,
    RenderedNewsletter,
    SubjectLineProposal,
)
from writer_engine.state_machine.hitl import ApprovalDecision, HitlGate, create_approval
from writer_engine.state_machine.orchestrator import OrchestratorBase
from writer_engine.state_machine.saga import StepRef, run_step_via_http

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


def _step(name: str) -> StepRef:
    env = f"{name.upper()}_STEP_URL"
    return StepRef(
        name=name, url=os.environ.get(env, f"http://{name.replace('_', '-')}-step:{DEFAULT_PORTS[name]}")
    )


class NewsletterOrchestrator(OrchestratorBase):
    """Saga coordinator for the newsletter pipeline."""

    pipeline_name = "newsletter"
    MAX_REVISIONS_PER_GATE = 2

    async def run(self, execution_id: UUID, *, payload: dict[str, Any] | None = None) -> dict[str, Any]:  # type: ignore[override]
        cfg = dict(payload or {})
        edition_id = str(cfg.get("edition_id") or "")
        send_date = str(cfg.get("send_date") or "")
        max_stories = int(cfg.get("max_stories") or 5)

        # ----- gather -----
        await self.advance(execution_id, Stage.GATHERING, message="gathering ingested articles")
        gather_out = await run_step_via_http(
            _step("gather"),
            execution_id=execution_id,
            payload={"send_date": send_date, "user_id": cfg.get("user_id") or "", "limit": 50},
        )
        articles: list[dict[str, Any]] = list(gather_out.payload.get("articles") or [])
        if not articles:
            await self.advance(execution_id, Stage.SKIPPED_NO_CONTENT, message="no ingested content for date")
            return {"execution_id": str(execution_id), "status": "skipped_no_content"}

        # ----- pick (with HITL gate + revision loop) -----
        picked = await self._pick_with_gate(execution_id, articles, max_stories)
        if picked is None:
            return {"execution_id": str(execution_id), "status": "rejected"}

        # ----- subject (with HITL gate + revision loop) -----
        subject_proposal = await self._subject_with_gate(execution_id, picked)
        if subject_proposal is None:
            return {"execution_id": str(execution_id), "status": "rejected"}

        # ----- segments (fan-out per story) + images + image-approval gate -----
        await self.advance(execution_id, Stage.WRITING_SEGMENTS, message="writing segments")
        segments_data: list[dict[str, Any]] = []
        image_options_by_story: list[dict[str, Any]] = []
        for story in picked.top_selected_stories:
            story_payload = story.model_dump(mode="json")
            sources = [a for a in articles if a.get("id") in story.identifiers]
            scrape_out = await run_step_via_http(
                _step("scrape"),
                execution_id=execution_id,
                payload={"urls": story.external_source_links},
            )
            scraped = scrape_out.payload.get("scraped") or []
            image_out = await run_step_via_http(
                _step("image"),
                execution_id=execution_id,
                payload={"story": story_payload, "scraped_images": []},
            )
            image_options_by_story.append(image_out.payload)
            seg_out = await run_step_via_http(
                _step("segment"),
                execution_id=execution_id,
                payload={
                    "story": story_payload,
                    "sources": sources + scraped,
                    "image_options": image_out.payload.get("options") or [],
                },
            )
            segments_data.append(seg_out.payload)

        await self.advance(execution_id, Stage.PROPOSING_IMAGES, message="proposing image options")
        # Image-review gate (decision #3)
        image_gate = await create_approval(
            execution_id=execution_id,
            stage="awaiting_image_approval",
            payload={"image_options_by_story": image_options_by_story, "segments": segments_data},
        )
        await self.advance(execution_id, Stage.AWAITING_IMAGE_APPROVAL, message="awaiting image approval")
        decision = await self._await_resolution(execution_id, image_gate)
        if decision is None or decision.decision is ApprovalDecision.REJECT:
            await self.fail(execution_id, code="REJECTED", message="image gate rejected")
            return {"execution_id": str(execution_id), "status": "rejected"}
        # If the operator chose specific images, apply them.
        chosen = decision.payload.get("chosen_images", {}) if isinstance(decision.payload, dict) else {}
        for seg in segments_data:
            title = seg.get("story_title")
            if title in chosen:
                seg["chosen_image_url"] = chosen[title]
        await self.advance(execution_id, Stage.IMAGES_APPROVED, message="images approved")

        # ----- assemble + render + persist -----
        await self.advance(execution_id, Stage.ASSEMBLING, message="assembling full newsletter")
        used_ids = {i for s in picked.top_selected_stories for i in s.identifiers}
        remaining_items = [a for a in articles if a.get("id") not in used_ids]
        asm_out = await run_step_via_http(
            _step("assemble"),
            execution_id=execution_id,
            payload={"segments": segments_data, "remaining_items": remaining_items},
        )
        assembled = AssembledNewsletter.model_validate(asm_out.payload)

        await self.advance(execution_id, Stage.RENDERING, message="rendering HTML")
        send_id_str = f"{edition_id}-{send_date}"
        permalink_url_placeholder = (
            f"{os.environ.get('ARCHIVE_BASE_URL', '').rstrip('/')}/{edition_id}/{send_id_str}.html"
        )
        ren_out = await run_step_via_http(
            _step("render"),
            execution_id=execution_id,
            payload={
                "edition_id": edition_id,
                "subject": subject_proposal.subject_line,
                "pre_header_text": subject_proposal.pre_header_text,
                "masthead": "The Workbench",
                "markdown_body": assembled.markdown_body,
                "permalink_url": permalink_url_placeholder,
            },
        )
        rendered = RenderedNewsletter.model_validate(ren_out.payload)

        send_row = NewsletterSendRow(
            user_id=str(cfg.get("user_id") or ""),
            edition_id=edition_id,
            send_date=send_date,
            subject=subject_proposal.subject_line,
            pre_header_text=subject_proposal.pre_header_text,
            markdown_body=assembled.markdown_body,
            html_body=rendered.html_body,
            status="saved",
            metadata={
                "selected_story_identifiers": [s.identifiers for s in picked.top_selected_stories],
                "subject_reasoning": subject_proposal.subject_line_reasoning,
            },
        )
        persist_out = await run_step_via_http(
            _step("persist"),
            execution_id=execution_id,
            payload={"row": send_row.model_dump(mode="json")},
        )
        saved = persist_out.payload.get("send_row", {})
        await self.advance(execution_id, Stage.SAVED, message="send row saved", patch={"send_row": saved})

        # ----- deliver (BOTH email + permalink, per decision #1) -----
        await self.advance(
            execution_id, Stage.SENDING, message="delivering to subscribers + publishing permalink"
        )
        deliver_out = await run_step_via_http(
            _step("deliver"),
            execution_id=execution_id,
            payload={
                "edition_id": edition_id,
                "send_id": saved.get("id") or send_id_str,
                "html_body": rendered.html_body,
                "subject": subject_proposal.subject_line,
            },
        )
        delivery = DeliveryResult.model_validate(deliver_out.payload)
        await self.advance(
            execution_id,
            Stage.SENT,
            message=f"sent to {delivery.recipients_emailed}; permalink {delivery.permalink_url}",
            patch={"delivery": delivery.model_dump(mode="json")},
        )
        return {
            "execution_id": str(execution_id),
            "status": "sent",
            "send_row": saved,
            "delivery": delivery.model_dump(mode="json"),
        }

    # ---------- HITL helpers ----------

    async def _pick_with_gate(
        self, execution_id: UUID, articles: list[dict[str, Any]], max_stories: int
    ) -> PickedStories | None:
        await self.advance(execution_id, Stage.PICKING, message="picking top stories")
        feedback: str | None = None
        for _ in range(self.MAX_REVISIONS_PER_GATE + 1):
            pick_out = await run_step_via_http(
                _step("pick"),
                execution_id=execution_id,
                payload={"articles": articles, "max_stories": max_stories, "feedback": feedback},
            )
            if pick_out.status is StepStatus.ERROR:
                await self.fail(
                    execution_id,
                    code="PICK_FAILED",
                    message=pick_out.error.message if pick_out.error else "pick failed",
                )
                return None
            picked = PickedStories.model_validate(pick_out.payload)
            gate = await create_approval(
                execution_id=execution_id,
                stage="awaiting_stories_approval",
                payload=picked.model_dump(mode="json"),
            )
            await self.advance(
                execution_id, Stage.AWAITING_STORIES_APPROVAL, message="awaiting stories approval"
            )
            decision = await self._await_resolution(execution_id, gate)
            if decision is None or decision.decision is ApprovalDecision.REJECT:
                return None
            if decision.decision is ApprovalDecision.APPROVE:
                await self.advance(execution_id, Stage.STORIES_APPROVED, message="stories approved")
                return picked
            feedback = decision.feedback or ""
        return picked  # max revisions reached — use last picked

    async def _subject_with_gate(
        self, execution_id: UUID, picked: PickedStories
    ) -> SubjectLineProposal | None:
        await self.advance(execution_id, Stage.SUBJECT, message="writing subject line")
        feedback: str | None = None
        for _ in range(self.MAX_REVISIONS_PER_GATE + 1):
            sub_out = await run_step_via_http(
                _step("subject"),
                execution_id=execution_id,
                payload={
                    "top_selected_stories": [s.model_dump(mode="json") for s in picked.top_selected_stories],
                    "feedback": feedback,
                },
            )
            if sub_out.status is StepStatus.ERROR:
                await self.fail(
                    execution_id,
                    code="SUBJECT_FAILED",
                    message=sub_out.error.message if sub_out.error else "subject failed",
                )
                return None
            proposal = SubjectLineProposal.model_validate(sub_out.payload)
            gate = await create_approval(
                execution_id=execution_id,
                stage="awaiting_subject_approval",
                payload=proposal.model_dump(mode="json"),
            )
            await self.advance(
                execution_id, Stage.AWAITING_SUBJECT_APPROVAL, message="awaiting subject approval"
            )
            decision = await self._await_resolution(execution_id, gate)
            if decision is None or decision.decision is ApprovalDecision.REJECT:
                return None
            if decision.decision is ApprovalDecision.APPROVE:
                await self.advance(execution_id, Stage.SUBJECT_APPROVED, message="subject approved")
                return proposal
            feedback = decision.feedback or ""
        return proposal

    async def _await_resolution(self, _execution_id: UUID, gate: HitlGate) -> HitlGate | None:
        """Wait for the gate to be resolved by the UI.

        In F0/F2 the orchestrator runs synchronously inside ``/pipelines/newsletter/run``. For real PROD, the
        gate persists and the saga RESUMES on the resolve call (the durable state machine — see
        :doc:`engine-framework` §5). Tests inject a pre-resolved gate via ``_TestAutoApprove``.
        """
        # Auto-resolution hook for tests + the docker-compose demo. Real deployment swaps this for an arq
        # job that the resolve endpoint enqueues.
        hook = _TEST_HOOK
        if hook is not None:
            return await hook(gate)
        return gate  # placeholder — the gate is held until the resume endpoint fires (real impl in F3)


# Test hook ---------------------------------------------------------------------------
_TEST_HOOK = None


def set_resolution_hook(hook):  # type: ignore[no-untyped-def]
    """Tests use this to auto-resolve gates so :meth:`run` flows end-to-end synchronously."""
    global _TEST_HOOK
    _TEST_HOOK = hook
