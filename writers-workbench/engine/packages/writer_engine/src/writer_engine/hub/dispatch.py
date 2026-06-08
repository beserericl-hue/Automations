"""Dispatch plan — pure mapping from a :class:`HubDecision` to an executable plan.

Kept side-effect-free so it is fully unit-testable: it decides *what call to make*, not how to make
it. The gateway route executes the plan over HTTP (sync ``call_sync`` or async ``enqueue``) against
the orchestrator's uniform ``POST /pipelines/write/{tool}/run`` route, which dispatches to the step
service (``async:false`` runs inline; default async enqueues to arq — CR-003).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .schemas import HubDecision, HubRequest

Action = Literal["reply", "call_sync", "enqueue"]

# Context keys carried into the step body so "write the next chapter" keeps working off the
# active project (anti-drift continuity, ties to CR-002) without the user repeating the title.
_CONTEXT_ANCHORS = ("project_id", "project_title")


@dataclass(frozen=True)
class DispatchPlan:
    action: Action
    assistant_message: str = ""
    tool: str | None = None
    op: str | None = None
    body: dict[str, Any] = field(default_factory=dict)


def build_dispatch_plan(decision: HubDecision, req: HubRequest) -> DispatchPlan:
    """Translate a routed decision into a concrete dispatch plan."""
    if decision.kind == "conversation":
        return DispatchPlan(
            action="reply",
            assistant_message=decision.assistant_message
            or "How can I help with your writing?",
        )

    body: dict[str, Any] = dict(decision.params)
    body["op"] = decision.op
    if req.user_id:
        body["user_id"] = req.user_id

    # Fill missing project anchors from conversation context.
    for key in _CONTEXT_ANCHORS:
        if not body.get(key) and req.context.get(key):
            body[key] = req.context[key]

    if decision.kind == "info":
        body["async"] = False
        return DispatchPlan(
            action="call_sync", assistant_message=decision.assistant_message,
            tool=decision.tool, op=decision.op, body=body,
        )

    # task — load-bearing generation: persist results (CR-001) and force the async queue path.
    body["persist"] = True
    body["async"] = True
    # Voice (and chat) need something to say the instant a task is queued — the work runs for minutes
    # on the arq queue. If the router didn't supply an ack, synthesise a generic one so Eve never goes
    # silent after kicking off a chapter/brainstorm/research/cover-art job.
    ack = decision.assistant_message or (
        "Got it — I've started on that. It runs in the background and I'll let you know when it's ready."
    )
    return DispatchPlan(
        action="enqueue", assistant_message=ack,
        tool=decision.tool, op=decision.op, body=body,
    )
