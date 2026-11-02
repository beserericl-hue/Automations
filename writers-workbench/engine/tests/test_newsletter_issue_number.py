"""Newsletter issue numbers (migration 041) — engine side.

The database trigger assigns the number; the engine (1) peeks it before rendering so the email prints
"Issue #N", (2) proposes N on the save, and (3) re-renders when the trigger handed out a different
number because another send of the edition took N first.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from persist_step.main import _to_db_row
from render_step.main import DEFAULT_TEMPLATE, _render_data

import orchestrator.newsletter_saga as saga_mod
from writer_engine import newsletter_issue
from writer_engine.newsletter_issue import _as_int, peek_issue_number, saved_issue_number
from writer_engine.schemas import Stage, StepOutput, StepStatus
from writer_engine.schemas.newsletter import NewsletterSendRow
from writer_engine.state_machine.durable import InMemorySagaRepo


def test_as_int_reads_rpc_shapes() -> None:
    assert _as_int(4) == 4
    assert _as_int([7]) == 7
    assert _as_int([{"newsletter_peek_issue_number": 3}]) == 3
    assert _as_int("12") == 12
    assert _as_int(None) is None
    assert _as_int(0) is None
    assert _as_int(True) is None
    assert _as_int([]) is None


def test_saved_issue_number() -> None:
    assert saved_issue_number({"issue_number": 9}) == 9
    assert saved_issue_number({"issue_number": None}) is None
    assert saved_issue_number(None) is None


@pytest.mark.asyncio
async def test_peek_without_supabase_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    class _S:
        supabase_url = ""
        supabase_service_role_key = ""

    monkeypatch.setattr(newsletter_issue, "get_settings", lambda: _S())
    assert await peek_issue_number("ai-news", "2026-11-02") is None
    assert await peek_issue_number("", "2026-11-02") is None


def test_render_data_carries_issue_number() -> None:
    data = _render_data(subject="s", preheader="p", markdown_body="b", send_date="2026-11-02", issue_number=5)
    assert data["issue"]["number"] == 5
    # Unknown number: leave the key out (never send a wrong number).
    data = _render_data(subject="s", preheader="p", markdown_body="b", send_date="2026-11-02")
    assert "number" not in data["issue"]


def test_fallback_template_prints_issue_line() -> None:
    html = DEFAULT_TEMPLATE.substitute(
        subject="s", masthead="m", preheader="p", body="b", permalink_url="u", issue_line="Issue #4 · "
    )
    assert "Issue #4 · p" in html


def _row(**kw: Any) -> NewsletterSendRow:
    base: dict[str, Any] = {
        "user_id": "+1",
        "edition_id": "ai-news",
        "send_date": "2026-11-02",
        "subject": "s",
        "markdown_body": "m",
        "html_body": "<p>h</p>",
    }
    base.update(kw)
    return NewsletterSendRow(**base)


def test_persist_proposes_number_only_when_known() -> None:
    assert _to_db_row(_row(issue_number=6), "x")["issue_number"] == 6
    # Omitted, not null: the upsert must not wipe an existing row's number.
    assert "issue_number" not in _to_db_row(_row(), "x")


async def _rendering_state(repo: InMemorySagaRepo) -> Any:
    eid = uuid4()
    await repo.create(
        execution_id=eid,
        pipeline="newsletter",
        initial_state={
            "cfg": {"edition_id": "ai-news", "send_date": "2026-11-02", "user_id": "+1"},
            "subject_proposal": {
                "subject_line": "Subj",
                "pre_header_text": "Pre",
                "subject_line_reasoning": "r",
            },
            "assembled": {"markdown_body": "# Body", "intro": "", "segments": []},
            "picked": {"top_selected_stories": []},
        },
    )
    return eid


class _FakeSteps:
    """Stands in for run_step_via_http: renders "Issue #N" and saves with a trigger-like number."""

    def __init__(self, db_number: int) -> None:
        self.db_number = db_number
        self.renders: list[int | None] = []
        self.persists: list[dict[str, Any]] = []

    async def __call__(self, step: Any, *, execution_id: Any, payload: Any, **kw: Any) -> StepOutput:
        if step.name == "render":
            self.renders.append(payload.get("issue_number"))
            out = {"html_body": f"Issue #{payload.get('issue_number')}"}
        else:
            row = payload["row"]
            self.persists.append({**row, "_key": kw.get("idempotency_key")})
            # The trigger keeps a free proposal, otherwise hands out db_number.
            n = row.get("issue_number")
            saved = n if n == self.db_number else self.db_number
            out = {"send_row": {"id": "row-1", "issue_number": saved, "html_body": row["html_body"]}}
        return StepOutput(execution_id=execution_id, step_name=step.name, status=StepStatus.OK, payload=out)


@pytest.mark.asyncio
async def test_rendering_uses_peeked_number(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSteps(db_number=4)

    async def _peek(edition_id: str, send_date: str) -> int:
        return 4

    monkeypatch.setattr(saga_mod, "peek_issue_number", _peek)
    monkeypatch.setattr(saga_mod, "run_step_via_http", fake)
    monkeypatch.setattr(saga_mod, "emit_progress", _noop)
    monkeypatch.setattr(saga_mod, "notify_workbench_stage", _noop)
    repo = InMemorySagaRepo()
    eid = await _rendering_state(repo)
    driver = saga_mod.NewsletterSagaDriver(repo)
    st = (await repo.load(eid)).state
    assert await driver._stage_rendering(eid, st) is Stage.SAVED
    assert fake.renders == [4]
    assert fake.persists[0]["issue_number"] == 4
    state = (await repo.load(eid)).state
    assert state["rendered_html"] == "Issue #4"
    assert state["send_row"]["issue_number"] == 4


@pytest.mark.asyncio
async def test_rendering_rerenders_when_number_was_taken(monkeypatch: pytest.MonkeyPatch) -> None:
    """Peeked 4, but a concurrent send saved #4 first: the trigger gives 5 and the email is redone."""
    fake = _FakeSteps(db_number=5)

    async def _peek(edition_id: str, send_date: str) -> int:
        return 4

    monkeypatch.setattr(saga_mod, "peek_issue_number", _peek)
    monkeypatch.setattr(saga_mod, "run_step_via_http", fake)
    monkeypatch.setattr(saga_mod, "emit_progress", _noop)
    monkeypatch.setattr(saga_mod, "notify_workbench_stage", _noop)
    repo = InMemorySagaRepo()
    eid = await _rendering_state(repo)
    driver = saga_mod.NewsletterSagaDriver(repo)
    st = (await repo.load(eid)).state
    await driver._stage_rendering(eid, st)
    assert fake.renders == [4, 5]
    # Two distinct idempotency keys, so the second save is not served from the first's cache.
    assert fake.persists[0]["_key"] != fake.persists[1]["_key"]
    state = (await repo.load(eid)).state
    assert state["rendered_html"] == "Issue #5"  # what deliver sends
    assert state["send_row"]["issue_number"] == 5


async def _noop(*args: Any, **kwargs: Any) -> None:
    return None
