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

# The ops that act ON an existing project, and so may inherit the conversation's project. Now that
# hub.memory remembers a project across turns, filling it into every op would be wrong in both
# directions: "brainstorm a new book called X" would be handed the last book's id (and revise it),
# and "find my blog about the Titanic" would be narrowed to one project and come back empty.
PROJECT_SCOPED_OPS = frozenset(
    {
        "chapter.write",
        "chapter.plan",
        "chapter.rewrite",
        "chapter.repair",
        "chapter.qa",
        "chapter.review",
        "brainstorm.revise-outline",
        "brainstorm.edit-outline",
        "story_bible.list",
        "story_bible.add",
        "story_bible.update",
        "media.cover-art",
    }
)


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
            assistant_message=decision.assistant_message or "How can I help with your writing?",
        )

    body: dict[str, Any] = dict(decision.params)
    body["op"] = decision.op
    if req.user_id:
        body["user_id"] = req.user_id

    # Content Studio ops act on the edition open in the studio page. It comes from the caller's context
    # (the Workbench put it there after checking the user owns it) and NEVER from the message: a
    # message that names another edition must not reach it. The step checks ownership again.
    if decision.tool == "studio":
        body.pop("edition_id", None)
        if req.context.get("edition_id"):
            body["edition_id"] = str(req.context["edition_id"])
        if req.context.get("week_of") and not body.get("week_of"):
            body["week_of"] = str(req.context["week_of"])

    # Fill missing project anchors from conversation context — only for ops scoped to a project, and
    # only when the message named no project of its own (a remembered id must never ride along with
    # a different title the user just typed).
    if f"{decision.tool}.{decision.op}" in PROJECT_SCOPED_OPS and not (
        body.get("project_id") or body.get("project_title")
    ):
        for key in _CONTEXT_ANCHORS:
            if req.context.get(key):
                body[key] = req.context[key]

    # library.lifecycle is an info op, but delete/undelete MUTATE + email and the suite drives them as
    # queued tasks (E2E-2 R94/R98); list_deleted + approve/publish/etc. stay synchronous reads/writes.
    force_task = (
        decision.tool == "library"
        and decision.op == "lifecycle"
        and str(body.get("action", "")).lower() in {"delete", "undelete"}
    )

    if decision.kind == "info" and not force_task:
        body["async"] = False
        return DispatchPlan(
            action="call_sync",
            assistant_message=decision.assistant_message,
            tool=decision.tool,
            op=decision.op,
            body=body,
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
        action="enqueue",
        assistant_message=ack,
        tool=decision.tool,
        op=decision.op,
        body=body,
    )
