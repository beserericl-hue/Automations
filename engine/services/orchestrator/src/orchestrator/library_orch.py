"""F0-8 vertical-slice orchestrator — drives the library.retrieve step end to end."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from writer_engine.config import get_settings
from writer_engine.schemas import Stage, StepStatus
from writer_engine.state_machine.orchestrator import OrchestratorBase
from writer_engine.state_machine.saga import StepRef, run_step_via_http


class LibraryRetrieveOrchestrator(OrchestratorBase):
    pipeline_name = "library_retrieve"

    def __init__(self, store: Any, *, step_url: str | None = None) -> None:
        super().__init__(store)
        self._step = StepRef(
            name="library_retrieve",
            url=step_url or _env("LIBRARY_RETRIEVE_STEP_URL", "http://localhost:8002"),
        )

    async def run(self, execution_id: UUID, *, payload: dict[str, Any] | None = None) -> dict[str, Any]:  # type: ignore[override]
        await self.advance(execution_id, Stage.GATHERING, message="library.retrieve started")
        try:
            output = await run_step_via_http(
                self._step,
                execution_id=execution_id,
                payload=payload or {},
                idempotency_key=f"{execution_id}:library_retrieve",
            )
        except Exception as exc:
            await self.fail(execution_id, code=type(exc).__name__, message=str(exc))
            raise

        if output.status == StepStatus.ERROR:
            await self.fail(
                execution_id,
                code=(output.error.code if output.error else "step_error"),
                message=(output.error.message if output.error else "step error"),
            )
            return {"execution_id": str(execution_id), "status": "error"}

        await self.advance(
            execution_id,
            Stage.SAVED,
            message=f"library.retrieve done — items={len(output.payload.get('items', []))}",
            patch={"items": output.payload.get("items", [])},
        )
        return {"execution_id": str(execution_id), "status": "ok", "items": output.payload.get("items", [])}


def _env(name: str, default: str) -> str:
    import os

    settings = get_settings()  # ensures .env is loaded
    _ = settings  # touch
    return os.environ.get(name, default)
