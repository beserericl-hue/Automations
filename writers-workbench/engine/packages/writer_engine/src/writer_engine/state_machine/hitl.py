"""Human-in-the-loop gate primitives.

An orchestrator that needs a human decision calls :func:`create_approval` (which writes to Redis primarily, and
also mirrors to Supabase ``newsletter_approvals_v2`` if configured) and stops the worker. The UI later calls
:func:`resolve_approval` which marks the decision; the engine then enqueues the next saga step.

Three decisions: ``approve``, ``revise`` (with feedback), and ``reject``.

Storage order of preference:

1. **Redis** (always, when reachable) — keyed ``hitl:{token}``; the durable resume model relies on this.
2. **Supabase** ``newsletter_approvals_v2`` (when configured) — mirror so the existing UI approval routes
   can read, AND (B13) so a gate survives the loss of the Redis container. Both halves matter: the
   write side has always been here, but the read side used to stop at the two volatile stores, which
   made a Redis restart indistinguishable from an approval that never existed.
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


# The inverse of _TABLE_STAGE, for reading a gate back out of the Supabase mirror. The saga's
# apply_decision routes on the VERBOSE stage, so a gate recovered from the mirror has to be restored
# to the verbose form or the resumed saga would not know which gate it was.
_ENGINE_STAGE: dict[str, str] = {
    "stories": "awaiting_stories_approval",
    "subject_line": "awaiting_subject_approval",
    "image": "awaiting_image_approval",
}


def _ms_from_iso(value: Any) -> int:
    """Parse a timestamptz the way PostgREST returns it. 0 when absent/unparseable."""
    if not value:
        return 0
    try:
        text = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return int(parsed.timestamp() * 1000)
    except ValueError:
        return 0


async def _mirror_read(token: str) -> HitlGate | None:
    """Read a gate back from the Supabase mirror (B13).

    This is the durability half that was missing. ``create_approval`` and ``resolve_approval`` have
    always written to ``newsletter_approvals_v2``, but the read path only ever consulted Redis and
    the in-process dict — so losing Redis turned every pending approval into "unknown approval
    token" while the row sat intact in Postgres. Since Redis is a single container with no replica,
    that is the difference between a restart and a newsletter whose human gate can never be answered.
    """
    try:
        from writer_engine.config import get_settings
        from writer_engine.supabase.client import get_supabase_admin

        settings = get_settings()
        if not (settings.supabase_url and settings.supabase_service_role_key):
            return None
        client = await get_supabase_admin()
        resp = await (
            client.table("newsletter_approvals_v2")
            .select("token, execution_id, stage, payload, expires_at, decision, feedback, resolved_at")
            .eq("token", token)
            .limit(1)
            .execute()
        )
        data = getattr(resp, "data", None)
        rows = [r for r in data if isinstance(r, dict)] if isinstance(data, list) else []
        if not rows:
            return None
        row = rows[0]
        decision = row.get("decision")
        stage = str(row.get("stage") or "")
        resolved = _ms_from_iso(row.get("resolved_at"))
        return HitlGate(
            token=str(row["token"]),
            execution_id=UUID(str(row["execution_id"])),
            stage=_ENGINE_STAGE.get(stage, stage),
            payload=row.get("payload") or {},
            expires_at_ms=_ms_from_iso(row.get("expires_at")),
            resolved_at_ms=resolved or None,
            decision=ApprovalDecision(decision) if decision else None,
            feedback=row.get("feedback"),
        )
    except Exception:
        return None


async def get_approval(token: str) -> HitlGate | None:
    """Look up a gate by token: Redis, then in-memory, then the Supabase mirror.

    The mirror is last because it is the slowest and the least current, and first-choice reads
    should not add a round trip to Postgres. It is consulted at all because the first two are both
    volatile: Redis is one container with no replica, and the in-process dict dies with the worker.
    A gate found in the mirror is written back to Redis so the rest of the saga's reads are cheap
    again once Redis returns.
    """
    gate = await _redis_read(token)
    if gate is not None:
        return gate
    gate = _in_memory.get(token)
    if gate is not None:
        return gate
    gate = await _mirror_read(token)
    if gate is not None:
        _in_memory[gate.token] = gate
        await _redis_write(gate)
    return gate


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
