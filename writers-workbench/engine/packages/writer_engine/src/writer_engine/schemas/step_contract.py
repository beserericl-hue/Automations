"""The uniform contract every step service implements.

A step takes a :class:`StepInput` referencing an ``execution_id`` and returns a :class:`StepOutput`.
The orchestrator persists state between steps in Supabase; steps themselves are stateless.
"""

from __future__ import annotations

from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class StepStatus(str, Enum):
    OK = "ok"
    ERROR = "error"
    PAUSED = "paused"  # the step requested a HITL pause (e.g. approval)


class Stage(str, Enum):
    """Coarse-grained pipeline stages — exposed in SSE progress."""

    INIT = "init"
    GATHERING = "gathering"
    PICKING = "picking"
    AWAITING_STORIES_APPROVAL = "awaiting_stories_approval"
    STORIES_APPROVED = "stories_approved"
    SUBJECT = "subject"
    AWAITING_SUBJECT_APPROVAL = "awaiting_subject_approval"
    SUBJECT_APPROVED = "subject_approved"
    WRITING_SEGMENTS = "writing_segments"
    PROPOSING_IMAGES = "proposing_images"
    AWAITING_IMAGE_APPROVAL = "awaiting_image_approval"
    IMAGES_APPROVED = "images_approved"
    ASSEMBLING = "assembling"
    RENDERING = "rendering"
    SAVED = "saved"
    SENDING = "sending"
    SENT = "sent"
    SCHEDULED = "scheduled"
    SKIPPED_NO_CONTENT = "skipped_no_content"
    ERROR = "error"


class StepError(BaseModel):
    code: str
    message: str
    details: dict[str, Any] | None = None


class StepInput(BaseModel):
    """Envelope every step accepts."""

    model_config = ConfigDict(extra="allow")

    execution_id: UUID = Field(description="Saga / pipeline execution id")
    step_name: str = Field(description="Name of the step, mirrors the service name")
    payload: dict[str, Any] = Field(default_factory=dict, description="Step-specific input")
    idempotency_key: str | None = Field(
        default=None,
        description="If set, the step result is cached under this key for replay safety",
    )


class StepOutput(BaseModel):
    """Envelope every step returns."""

    execution_id: UUID
    step_name: str
    status: StepStatus = StepStatus.OK
    payload: dict[str, Any] = Field(default_factory=dict)
    error: StepError | None = None
    next_stage: Stage | None = Field(default=None, description="Hint for the orchestrator")


class Progress(BaseModel):
    """One SSE event emitted by the orchestrator while a pipeline advances."""

    execution_id: UUID
    stage: Stage
    message: str | None = None
    payload: dict[str, Any] | None = None
    ts_ms: int = Field(default=0, description="Server timestamp (ms since epoch); 0 = filled by emitter")


class ExecutionState(BaseModel):
    """Durable execution row — mirrors the Supabase persistence shape."""

    execution_id: UUID
    pipeline: str
    stage: Stage = Stage.INIT
    status: StepStatus = StepStatus.OK
    state: dict[str, Any] = Field(default_factory=dict)
    error: StepError | None = None
    revision_count: int = 0
    created_at_ms: int = 0
    updated_at_ms: int = 0
