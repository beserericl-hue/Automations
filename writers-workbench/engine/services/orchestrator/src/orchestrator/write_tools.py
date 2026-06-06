"""Write-workshop tool registry — shared by the orchestrator routes and the arq worker.

Tool name == the step service STEP_NAME (so StepInput.step_name validates). Heavy tools default to
async (enqueue + poll) because a sub-chapter fan-out or a full-novel outline runs well past the
~300s synchronous edge limit.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

# tool -> (settings -> step url)
WRITE_TOOL_URLS: dict[str, Callable[[Any], str]] = {
    "chapter": lambda s: s.chapter_step_url,
    "research": lambda s: s.research_step_url,
    "brainstorm": lambda s: s.brainstorm_step_url,
    "media": lambda s: s.media_step_url,
    "library": lambda s: s.library_step_url,
    "story_bible": lambda s: s.story_bible_step_url,
    "approval": lambda s: s.approval_step_url,
    "notify": lambda s: s.notify_step_url,
}

# Tools whose generation routinely exceeds the synchronous edge limit — default to async.
ASYNC_DEFAULT_TOOLS = frozenset({"chapter", "brainstorm", "research"})

# Per-step timeout for the worker→step HTTP call. Must be >= the arq job_timeout (5400s) so the HTTP
# read doesn't die before arq's own ceiling — under 10-concurrent a single chapter's wall-time runs
# well past 30 min because the batch shares one account's output-TPM. Slightly above job_timeout so
# arq is the authoritative ceiling, not a mid-flight httpx ReadTimeout.
WORKER_STEP_TIMEOUT_S = 5460.0


def resolve_step_url(tool: str, settings: Any) -> str | None:
    getter = WRITE_TOOL_URLS.get(tool)
    return getter(settings) if getter else None


def is_async(tool: str, body: dict) -> bool:
    """Async when the caller asks (`async: true`) or the tool defaults to async; sync if `async: false`."""
    if "async" in body:
        return bool(body["async"])
    return tool in ASYNC_DEFAULT_TOOLS
