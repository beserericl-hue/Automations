"""Human-in-the-loop gate primitives.

An orchestrator that needs a human decision calls :func:`create_approval` (which writes to Redis primarily, and
also mirrors to Supabase ``newsletter_approvals_v2`` if configured) and stops the worker. The UI later calls
:func:`resolve_approval` which marks the decision; the engine then enqueues the next saga step.

Three decisions: ``approve``, ``revise`` (with feedback), and ``reject``.

Storage order of preference:

1. **Redis** (always, when reachable) — keyed ``hitl:{token}``; the durable resume model relies on this.
2. **Supabase** ``newsletter_approvals_v2`` (when configured) — mirror so the existing UI approval routes can read.
3. **In-memory** module dict — final fallback so tests + the local docker-compose demo still work without Redis.
"""

from __future__ import annotations

import json
import secrets
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any
from uuid import UUID

from writer_engine.redis_client import client as _redis_module


class ApprovalDecision(str, Enum):
    APPROVE = "approve"
    REVISE = "revise"
    REJECT = "reject"


@dataclass
class HitlGate:
    token: str
    execution_id: UUID
    stage: str
    payload: dict[str, Any] = field(default_factory=dict)
    expires_at_ms: int = 0
    resolved_at_ms: int | None = None
    decision: ApprovalDecision | None = None
    feedback: str | None = None


_in_memory: dict[str, HitlGate] = {}

# The engine's internal gate stages are verbose ("awaiting_stories_approval"),
# but the Workbench UI + the newsletter_approvals_v2 CHECK constraint speak a
# short vocabulary ("stories" / "subject_line" / "image"). The Supabase mirror
# (and only the mirror) translates through this map. Redis / HitlGate.stage
# keep the verbose form because the saga's apply_decision routes on it.
_TABLE_STAGE: dict[str, str] = {
    "awaiting_stories_approval": "stories",
    "awaiting_subject_approval": "subject_line",
    "awaiting_image_approval": "image",
    # pass-throughs so callers may use either form
    "stories": "stories",
    "subject_line": "subject_line",
    "image": "image",
}


def _table_stage(stage: str) -> str:
    return _TABLE_STAGE.get(stage, "stories")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _key(token: str) -> str:
    return f"hitl:{token}"


def _serialize(gate: HitlGate) -> str:
    data = asdict(gate)
    data["execution_id"] = str(gate.execution_id)
    if gate.decision is not None:
        data["decision"] = gate.decision.value
    return json.dumps(data)


def _deserialize(raw: str) -> HitlGate:
    data = json.loads(raw)
    decision = data.get("decision")
    return HitlGate(
        token=data["token"],
        execution_id=UUID(data["execution_id"]),
        stage=data["stage"],
        payload=data.get("payload") or {},
        expires_at_ms=int(data.get("expires_at_ms") or 0),
        resolved_at_ms=int(data["resolved_at_ms"]) if data.get("resolved_at_ms") else None,
        decision=ApprovalDecision(decision) if decision else None,
        feedback=data.get("feedback"),
    )


async def _redis_write(gate: HitlGate) -> bool:
    """Best-effort write to Redis. Returns True on success; False (silently) on any error."""
    try:
        client = await _redis_module.get_redis()
        ttl = max(60, (gate.expires_at_ms - _now_ms()) // 1000)
        await client.set(_key(gate.token), _serialize(gate), ex=ttl)
        return True
    except Exception:
        return False


async def _redis_read(token: str) -> HitlGate | None:
    try:
        client = await _redis_module.get_redis()
        raw = await client.get(_key(token))
        if raw is None:
            return None
        return _deserialize(raw)
    except Exception:
        return None


async def create_approval(
    *,
    execution_id: UUID,
    stage: str,
    payload: dict[str, Any] | None = None,
    user_id: str | None = None,
    edition_id: str | None = None,
    ttl_seconds: int = 7 * 24 * 60 * 60,
) -> HitlGate:
    """Create an approval gate. Writes to Redis (primary), Supabase (mirror), and in-memory (fallback).

    ``user_id`` is required for the Supabase mirror — newsletter_approvals_v2.user_id is NOT NULL and
    FKs to users_v2, and the Workbench in-app resolve route enforces session-user ownership against it.
    When ``user_id`` is absent (tests, the local docker-compose demo) the mirror is skipped; Redis +
    in-memory still hold the gate so the saga resumes.
    """
    gate = HitlGate(
        token=secrets.token_urlsafe(24),
        execution_id=execution_id,
        stage=stage,
        payload=payload or {},
        expires_at_ms=_now_ms() + ttl_seconds * 1000,
    )

    # 1. Redis (best-effort).
    await _redis_write(gate)

    # 2. Supabase (mirror for the existing UI routes). Only when we have the user_id the
    #    NOT NULL / FK / ownership-check all require. resume_url is omitted (n8n-only; nullable
    #    as of migration 023) — the Workbench resolves engine rows via the engine endpoint, not
    #    a Wait-node URL. The stage is mapped to the table's short vocabulary.
    try:
        from writer_engine.config import get_settings
        from writer_engine.supabase.client import get_supabase_admin

        settings = get_settings()
        if settings.supabase_url and settings.supabase_service_role_key and user_id:
            row: dict[str, Any] = {
                "token": gate.token,
                "user_id": user_id,
                "execution_id": str(execution_id),
                "stage": _table_stage(stage),
                "payload": gate.payload,
                "expires_at": _iso_from_ms(gate.expires_at_ms),
            }
            if edition_id:
                row["edition_id"] = edition_id
            client = await get_supabase_admin()
            await client.table("newsletter_approvals_v2").insert(row).execute()
    except Exception:
        pass

    # 3. In-memory fallback (always — keeps the docker-compose demo + tests working).
    _in_memory[gate.token] = gate
    return gate


async def get_approval(token: str) -> HitlGate | None:
    """Look up a gate by token. Tries Redis first, then in-memory."""
    gate = await _redis_read(token)
    if gate is not None:
        return gate
    return _in_memory.get(token)


async def resolve_approval(
    token: str,
    *,
    decision: ApprovalDecision,
    feedback: str | None = None,
) -> HitlGate:
    """Resolve a gate. Raises ``KeyError`` if unknown, ``RuntimeError`` if already resolved, ``TimeoutError`` if expired."""
    gate = await get_approval(token)
    if gate is None:
        raise KeyError(f"unknown approval token: {token}")
    if gate.resolved_at_ms is not None:
        raise RuntimeError("approval already resolved")
    if gate.expires_at_ms < _now_ms():
        raise TimeoutError("approval expired")
    gate.resolved_at_ms = _now_ms()
    gate.decision = decision
    gate.feedback = feedback

    # Persist updated gate everywhere we wrote it.
    await _redis_write(gate)
    _in_memory[gate.token] = gate
    try:
        from writer_engine.config import get_settings
        from writer_engine.supabase.client import get_supabase_admin

        settings = get_settings()
        if settings.supabase_url and settings.supabase_service_role_key and gate.resolved_at_ms is not None:
            client = await get_supabase_admin()
            await (
                client.table("newsletter_approvals_v2")
                .update(
                    {
                        "decision": decision.value,
                        "feedback": feedback,
                        "resolved_at": _iso_from_ms(gate.resolved_at_ms),
                    }
                )
                .eq("token", token)
                .execute()
            )
    except Exception:
        pass

    return gate


def _iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat()


__all__ = [
    "ApprovalDecision",
    "HitlGate",
    "create_approval",
    "get_approval",
    "resolve_approval",
]
