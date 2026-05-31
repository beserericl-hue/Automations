"""HITL gate — create / resolve / expiry / already-resolved."""

from __future__ import annotations

from uuid import uuid4

import pytest

from writer_engine.state_machine.hitl import (
    ApprovalDecision,
    create_approval,
    resolve_approval,
)


@pytest.mark.asyncio
async def test_create_and_resolve_approve() -> None:
    eid = uuid4()
    gate = await create_approval(execution_id=eid, stage="awaiting_stories_approval", payload={"k": 1})
    resolved = await resolve_approval(gate.token, decision=ApprovalDecision.APPROVE)
    assert resolved.decision is ApprovalDecision.APPROVE


@pytest.mark.asyncio
async def test_resolve_unknown_raises() -> None:
    with pytest.raises(KeyError):
        await resolve_approval("nope", decision=ApprovalDecision.APPROVE)


@pytest.mark.asyncio
async def test_resolve_twice_raises() -> None:
    eid = uuid4()
    gate = await create_approval(execution_id=eid, stage="stories")
    await resolve_approval(gate.token, decision=ApprovalDecision.APPROVE)
    with pytest.raises(RuntimeError):
        await resolve_approval(gate.token, decision=ApprovalDecision.APPROVE)


@pytest.mark.asyncio
async def test_expired_raises() -> None:
    eid = uuid4()
    gate = await create_approval(execution_id=eid, stage="stories", ttl_seconds=0)
    # ttl_seconds=0 means expires_at_ms == now -> next call sees it as expired
    import asyncio

    await asyncio.sleep(0.01)
    with pytest.raises(TimeoutError):
        await resolve_approval(gate.token, decision=ApprovalDecision.APPROVE)


@pytest.mark.asyncio
async def test_create_approval_without_user_id_skips_mirror_but_resolves() -> None:
    """No user_id (tests / docker-compose) -> Supabase mirror skipped; gate still usable via Redis/in-memory."""
    eid = uuid4()
    gate = await create_approval(
        execution_id=eid,
        stage="awaiting_image_approval",
        payload={"options": [1, 2]},
    )
    # Engine keeps the verbose stage on the gate (apply_decision routes on it).
    assert gate.stage == "awaiting_image_approval"
    resolved = await resolve_approval(gate.token, decision=ApprovalDecision.APPROVE)
    assert resolved.decision is ApprovalDecision.APPROVE


@pytest.mark.asyncio
async def test_create_approval_accepts_user_and_edition_kwargs() -> None:
    """user_id + edition_id are accepted even when no Supabase is configured (mirror is a no-op then)."""
    eid = uuid4()
    gate = await create_approval(
        execution_id=eid,
        stage="awaiting_subject_approval",
        payload={"subject": "hi"},
        user_id="+14105914612",
        edition_id="ai-news",
    )
    assert gate.token
    resolved = await resolve_approval(gate.token, decision=ApprovalDecision.REVISE, feedback="shorter")
    assert resolved.decision is ApprovalDecision.REVISE
    assert resolved.feedback == "shorter"


def test_table_stage_maps_verbose_to_short() -> None:
    from writer_engine.state_machine.hitl import _table_stage

    assert _table_stage("awaiting_stories_approval") == "stories"
    assert _table_stage("awaiting_subject_approval") == "subject_line"
    assert _table_stage("awaiting_image_approval") == "image"
    assert _table_stage("subject_line") == "subject_line"
    assert _table_stage("image") == "image"
    assert _table_stage("garbage") == "stories"
