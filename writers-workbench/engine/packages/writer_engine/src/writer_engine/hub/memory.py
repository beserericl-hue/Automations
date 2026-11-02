"""Hub conversation memory — what the hub remembers between turns of one conversation.

The router has always *read* conversation context (``context.last_list`` for "pick #3",
``last_research_title`` for "blog about THAT", ``project_id`` for "write the next chapter"), but
nothing ever *wrote* it: the chat route sent only the page's project, and the voice webhook sent
nothing. So "list my outlines" → "pick #3" fell through to Gemini with no list to pick from.

This module is that missing writer. One small JSON document per (user, conversation) in Redis,
with a TTL, holding:

* ``last_list``      — the items the last list-shaped answer showed, in display order, compacted to
                       the fields a follow-up needs (title, content_type, ids);
* ``project_id`` / ``project_title`` — the project the conversation is about;
* ``last_content_title`` / ``last_research_title`` — the anchors "that" / "it" resolve to;
* ``turns``          — the last few user/assistant lines, for the router prompt.

The gateway loads it before routing (merged UNDER the caller's explicit context, so the page the
user is on beats what the conversation remembered) and saves it after the response is built.

Keying: ``conversation_id`` when the caller sends one (the Workbench chat drawer always does; an
ElevenLabs agent can send ``system__conversation_id``). Without one the conversation is the user's
default for that surface, ``chat:default`` / ``voice:default``. The voice default has a short TTL
(one call's worth), because the DEV demo agent sends no conversation id and a list from yesterday's
call must not answer today's "number three".

Never raises and never blocks the hub for long: Redis trouble means a turn without memory, which is
exactly how every turn behaved before this existed.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

from .schemas import HubRequest, HubResponse

logger = get_logger("hub.memory")

KEY_PREFIX = "hub:conv"
MAX_TURNS = 12
MAX_LIST_ITEMS = 25
TURN_CHARS = 400
REDIS_TIMEOUT_S = 1.5
"""A memory read/write that takes longer than this is abandoned: the turn goes ahead without it."""

# The keys this module owns inside a HubRequest.context. Everything else the caller sends is passed
# through untouched.
_ANCHORS = ("project_id", "project_title", "last_content_title", "last_research_title")


class ConversationState(BaseModel):
    """One conversation's memory. Serialised as JSON under :func:`conversation_key`."""

    conversation_id: str
    last_list: list[dict[str, Any]] = Field(default_factory=list)
    last_list_source: str | None = None
    """``tool.op`` that produced ``last_list`` — useful when debugging a wrong pick."""
    project_id: str | None = None
    project_title: str | None = None
    last_content_title: str | None = None
    last_research_title: str | None = None
    turns: list[dict[str, Any]] = Field(default_factory=list)
    updated_at: str | None = None

    def as_context(self) -> dict[str, Any]:
        """The router-facing view: only keys with a value, so an empty memory adds nothing."""
        ctx: dict[str, Any] = {}
        if self.last_list:
            ctx["last_list"] = self.last_list
        for key in _ANCHORS:
            val = getattr(self, key)
            if val:
                ctx[key] = val
        if self.project_title:
            ctx["last_project_title"] = self.project_title
        if self.turns:
            ctx["recent_turns"] = self.turns[-6:]
        return ctx


def conversation_id_for(req: HubRequest) -> str:
    """The caller's conversation id, or the surface default (``chat:default`` / ``voice:default``)."""
    cid = (req.conversation_id or "").strip()
    return cid[:128] if cid else f"{req.source}:default"


def conversation_key(user_id: str, conversation_id: str) -> str:
    return f"{KEY_PREFIX}:{user_id}:{conversation_id}"


def ttl_for(req: HubRequest) -> int:
    """Voice without an explicit id gets the short TTL; everything else the chat TTL."""
    s = get_settings()
    if req.source == "voice" and not (req.conversation_id or "").strip():
        return max(60, int(s.hub_voice_conversation_ttl_seconds))
    return max(60, int(s.hub_conversation_ttl_seconds))


def enabled_for(req: HubRequest) -> bool:
    return bool(get_settings().hub_memory_enabled and req.user_id)


async def _redis() -> Any:
    # Looked up at call time (not imported by name) so tests can swap in fakeredis.
    from writer_engine.redis_client import client as redis_module

    return await redis_module.get_redis()


async def load_state(req: HubRequest) -> ConversationState | None:
    """Read this request's conversation memory. None when disabled, absent, or Redis is unhappy."""
    if not enabled_for(req):
        return None
    cid = conversation_id_for(req)
    try:
        r = await _redis()
        raw = await asyncio.wait_for(r.get(conversation_key(str(req.user_id), cid)), REDIS_TIMEOUT_S)
    except Exception as exc:
        logger.warning("hub.memory.load_failed", error=f"{type(exc).__name__}: {str(exc)[:160]}")
        return None
    if not raw:
        return ConversationState(conversation_id=cid)
    try:
        return ConversationState.model_validate(json.loads(raw))
    except Exception:
        # A document from an older shape is not worth failing a turn over; start the memory afresh.
        return ConversationState(conversation_id=cid)


async def save_state(req: HubRequest, state: ConversationState) -> bool:
    if not enabled_for(req):
        return False
    state.updated_at = datetime.now(UTC).isoformat()
    try:
        r = await _redis()
        await asyncio.wait_for(
            r.set(
                conversation_key(str(req.user_id), state.conversation_id),
                state.model_dump_json(),
                ex=ttl_for(req),
            ),
            REDIS_TIMEOUT_S,
        )
        return True
    except Exception as exc:
        logger.warning("hub.memory.save_failed", error=f"{type(exc).__name__}: {str(exc)[:160]}")
        return False


def with_memory(req: HubRequest, state: ConversationState | None) -> HubRequest:
    """``req`` with the remembered context merged UNDER what the caller sent explicitly."""
    if state is None:
        return req
    merged = {**state.as_context(), **{k: v for k, v in (req.context or {}).items() if v not in (None, "")}}
    return req.model_copy(update={"context": merged})


# --------------------------------------------------------------------------- recording a turn


def _result_of(data: Any) -> dict[str, Any] | None:
    """The op's own result from a sync call: the orchestrator wraps it as ``{payload:{result}}``;
    tests (and some callers) pass ``{result}`` directly."""
    if not isinstance(data, dict):
        return None
    payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
    result = payload.get("result") if isinstance(payload, dict) else None
    return result if isinstance(result, dict) else None


def _s(v: Any) -> str | None:
    return str(v) if v not in (None, "") else None


def _compact_item(
    item: dict[str, Any], *, tool: str | None, op: str | None, ctype: str | None
) -> dict[str, Any]:
    """Shrink one row to what a numbered follow-up needs. The shape is what
    ``router._numbered_selection`` reads: ``title``, ``content_type`` and whatever ids apply."""
    if tool == "story_bible":
        return {
            "title": _s(item.get("name")),
            "name": _s(item.get("name")),
            "entry_type": _s(item.get("entry_type")),
            "content_type": "story_bible_entry",
            "project_id": _s(item.get("project_id")),
            "id": _s(item.get("id")),
        }
    if op == "list-outlines" or ctype == "outline":
        # writing_projects_v2 rows: the row id IS the project id.
        return {
            "title": _s(item.get("title")),
            "project_title": _s(item.get("title")),
            "project_id": _s(item.get("id")),
            "content_type": "outline",
        }
    if ctype == "research":
        return {
            "title": _s(item.get("topic") or item.get("title")),
            "content_type": "research",
            "id": _s(item.get("id")),
        }
    if ctype == "story_arc":
        return {"title": _s(item.get("name")), "name": _s(item.get("name")), "content_type": "story_arc"}
    out = {
        "title": _s(item.get("title")),
        "content_type": _s(item.get("content_type")) or ctype,
        "project_id": _s(item.get("project_id")),
        "id": _s(item.get("id")),
    }
    if item.get("chapter_number") is not None:
        out["chapter_number"] = item["chapter_number"]
    return out


def extract_list(tool: str | None, op: str | None, data: Any) -> list[dict[str, Any]] | None:
    """The list an info answer showed, compacted, or None when the answer was not a list."""
    result = _result_of(data)
    if result is None:
        return None
    rows = result.get("entries") if tool == "story_bible" else result.get("items")
    if not isinstance(rows, list) or not rows:
        return None
    ctype = _s(result.get("content_type"))
    items = [
        {k: v for k, v in _compact_item(r, tool=tool, op=op, ctype=ctype).items() if v is not None}
        for r in rows[:MAX_LIST_ITEMS]
        if isinstance(r, dict)
    ]
    return items or None


def record_turn(
    state: ConversationState,
    *,
    req: HubRequest,
    resp: HubResponse,
    body: dict[str, Any] | None = None,
) -> ConversationState:
    """Fold one finished turn into ``state``: the turn lines, any list shown, and the anchors.

    ``body`` is the dispatched step body (params + the anchors dispatch filled), when a tool ran.
    """
    body = body or {}
    now = datetime.now(UTC).isoformat()
    state.turns.append({"role": "user", "text": (req.message or "")[:TURN_CHARS], "at": now})
    assistant: dict[str, Any] = {
        "role": "assistant",
        "text": (resp.assistant_message or "")[:TURN_CHARS],
        "at": now,
    }
    if resp.tool:
        assistant["tool"] = f"{resp.tool}.{resp.op}"
    if resp.job_id:
        assistant["job_id"] = resp.job_id
    state.turns.append(assistant)
    state.turns = state.turns[-MAX_TURNS:]

    # The project the turn worked on. An explicit title the user named moves the conversation to
    # that project; the id only moves with it when the step resolved one.
    title = _s(body.get("project_title"))
    pid = _s(body.get("project_id"))
    result = _result_of(resp.data) if resp.kind == "data" else None
    if result:
        pid = _s(result.get("project_id")) or pid
    if title and title != state.project_title:
        state.project_title, state.project_id = title, pid
    elif pid:
        state.project_id = pid
    # The page the user is on (the caller's explicit context) is the strongest signal of all.
    ctx = req.context or {}
    if _s(ctx.get("project_id")):
        state.project_id = _s(ctx.get("project_id"))
        state.project_title = _s(ctx.get("project_title")) or state.project_title

    if resp.kind == "data":
        items = extract_list(resp.tool, resp.op, resp.data)
        if items:
            state.last_list = items
            state.last_list_source = f"{resp.tool}.{resp.op}"
            if len(items) == 1:
                only = items[0]
                if only.get("content_type") == "research":
                    state.last_research_title = only.get("title") or state.last_research_title
                elif only.get("content_type") == "outline":
                    state.project_title = only.get("project_title") or state.project_title
                    state.project_id = only.get("project_id") or state.project_id
                elif only.get("content_type") != "story_bible_entry":
                    state.last_content_title = only.get("title") or state.last_content_title
    elif resp.kind == "queued" and resp.tool == "research" and _s(body.get("topic")):
        state.last_research_title = _s(body.get("topic"))
    return state


__all__ = [
    "MAX_TURNS",
    "ConversationState",
    "conversation_id_for",
    "conversation_key",
    "extract_list",
    "load_state",
    "record_turn",
    "save_state",
    "ttl_for",
    "with_memory",
]
