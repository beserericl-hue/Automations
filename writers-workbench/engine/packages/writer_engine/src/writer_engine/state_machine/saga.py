"""Step invocation: HTTP today; same call signature when we add arq enqueue."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx

from writer_engine.config import get_settings
from writer_engine.schemas.step_contract import StepInput, StepOutput


@dataclass(frozen=True)
class StepRef:
    """A named reference to a step service."""

    name: str
    url: str


async def run_step_via_http(
    step: StepRef,
    *,
    execution_id: UUID,
    payload: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
    timeout_s: float = 60.0,
) -> StepOutput:
    """POST ``/run`` on a step service and return the parsed :class:`StepOutput`."""
    settings = get_settings()
    headers = {"x-service-secret": settings.service_shared_secret, "content-type": "application/json"}
    body = StepInput(
        execution_id=execution_id,
        step_name=step.name,
        payload=payload or {},
        idempotency_key=idempotency_key,
    ).model_dump(mode="json")

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(f"{step.url}/run", headers=headers, json=body)
        resp.raise_for_status()
        return StepOutput.model_validate(resp.json())
