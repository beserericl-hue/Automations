"""Emit SSE-friendly progress events through Redis pub/sub."""

from __future__ import annotations

import time
from typing import Any
from uuid import UUID

from writer_engine.redis_client.client import publish_progress
from writer_engine.schemas.step_contract import Progress, Stage


async def emit_progress(
    execution_id: UUID | str,
    stage: Stage,
    *,
    message: str | None = None,
    payload: dict[str, Any] | None = None,
) -> Progress:
    """Build a Progress event and publish it to the execution's SSE channel."""
    event = Progress(
        execution_id=UUID(str(execution_id)),
        stage=stage,
        message=message,
        payload=payload,
        ts_ms=int(time.time() * 1000),
    )
    await publish_progress(execution_id, event.model_dump(mode="json"))
    return event
