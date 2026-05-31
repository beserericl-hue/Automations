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
