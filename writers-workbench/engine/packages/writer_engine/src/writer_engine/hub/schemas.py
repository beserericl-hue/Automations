"""Hub request / decision / response schemas.

``HubRequest``  — what the UI chat endpoint and the Eve voice webhook normalise into.
``HubDecision`` — what the Gemini router emits (validated; tolerant of model quirks).
``HubResponse`` — what the hub returns to the caller; its ``kind`` drives the server's sync/async map.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

DecisionKind = Literal["conversation", "info", "task"]


class HubRequest(BaseModel):
    """A normalised inbound message. The chat route and the voice webhook both build one of these."""

    message: str
    user_id: str | None = None
    conversation_id: str | None = None
    source: Literal["chat", "voice"] = "chat"
    # Lightweight conversation context the router can use (Sprint A: passed in; Sprint B: server-side store).
    context: dict[str, Any] = Field(default_factory=dict)

    @field_validator("message", mode="before")
    @classmethod
    def _coerce_message(cls, v: Any) -> str:
        return "" if v is None else str(v)


class HubDecision(BaseModel):
    """The router's structured output: which tool/op to run and the params it could extract."""

    kind: DecisionKind
    tool: str | None = None
    op: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    # A natural-language line the hub can speak/show: the reply for conversation, or an ack/summary.
    assistant_message: str = ""
    # Router self-assessed confidence; low confidence can fall back to conversation/clarify.
    confidence: float = 1.0

    @field_validator("params", mode="before")
    @classmethod
    def _coerce_params(cls, v: Any) -> dict[str, Any]:
        return v if isinstance(v, dict) else {}

    @field_validator("confidence", mode="before")
    @classmethod
    def _coerce_conf(cls, v: Any) -> float:
        try:
            return float(v)
        except (TypeError, ValueError):
            return 1.0


class HubResponse(BaseModel):
    """The hub's reply to the caller. ``kind`` mirrors the dispatch outcome:

    * ``reply``  — conversation; ``assistant_message`` is the answer.
    * ``data``   — an info op ran synchronously; ``data`` holds the step result.
    * ``queued`` — a task was enqueued; ``job_id`` + ``status`` let the caller poll.
    """

    kind: Literal["reply", "data", "queued", "error"]
    assistant_message: str = ""
    tool: str | None = None
    op: str | None = None
    # info
    data: Any | None = None
    # task
    job_id: str | None = None
    status: str | None = None
    # error / clarify
    error: str | None = None
