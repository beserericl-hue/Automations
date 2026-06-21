"""Engine hub (CR-004) — the conversational brain that replaces the n8n 'The Author Agent'.

A Gemini router (:func:`route_message`) turns a chat/voice message into a :class:`HubDecision`;
:func:`build_dispatch_plan` maps that to a sync info call or an async (queued) task. The gateway
``/internal/hub`` route executes the plan.
"""

from __future__ import annotations

from .catalog import CATALOG, ToolSpec, lookup, tool_names
from .dispatch import DispatchPlan, build_dispatch_plan
from .router import route_message, split_tasks
from .schemas import HubDecision, HubRequest, HubResponse

__all__ = [
    "CATALOG",
    "DispatchPlan",
    "HubDecision",
    "HubRequest",
    "HubResponse",
    "ToolSpec",
    "build_dispatch_plan",
    "lookup",
    "route_message",
    "split_tasks",
    "tool_names",
]
