"""notify-step — eve-callback / eve-reset-greeting / email."""

from __future__ import annotations

import re

from writer_engine.config import get_settings
from writer_engine.postal import send_email
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "notify"
logger = get_logger("notify_step")

_CALLBACK_STOP = {
    "the", "a", "an", "of", "for", "about", "on", "my", "me", "pull", "up", "call", "back", "and",
    "to", "so", "we", "can", "let", "lets", "let's", "get", "load", "review", "revise", "it", "that",
    "instead", "now", "help", "improve", "draft", "story", "report", "post", "blog", "research",
    "newsletter", "chapter", "outline", "this",
}


async def _supabase_or_none():
    s = get_settings()
    if not s.supabase_url:
        return None
    from writer_engine.supabase.client import get_supabase_admin

    return await get_supabase_admin()


async def _op_email(payload: dict) -> dict:
    to = list(payload.get("to") or [])
    if not to:
        return {"sent": 0}
    # Postal authenticates the From domain — default to the authorised sender, never a .local
    # placeholder (which Postal rejects as UnauthenticatedFromAddress and silently drops).
    from_addr = str(payload.get("from_addr") or get_settings().newsletter_from_address)
    res = await send_email(
        to=to,
        from_addr=from_addr,
        subject=str(payload.get("subject") or "Notification"),
        html=str(payload.get("html") or ""),
    )
    return {"sent": len(to), "message_id": res.message_id}


_CONTENT_TYPE_TABLE = {
    "research_report": "research_reports_v2", "research": "research_reports_v2",
}


async def _resolve_callback_content(payload: dict) -> dict | None:
    """Find the content the caller asked to discuss (E2E-5). Research reports → research_reports_v2;
    everything else → published_content_v2. Keyword-matches the request against title/text. Returns
    {content_type, title, content_text} or None (V30 not-found → no callback)."""
    client = await _supabase_or_none()
    if client is None:
        return None
    content_type = str(payload.get("content_type") or "")
    term = str(payload.get("search_term") or payload.get("content_title") or payload.get("title") or "")
    kws = [w for w in re.findall(r"[a-z0-9']+", term.lower()) if w not in _CALLBACK_STOP and len(w) > 2]
    user_id = payload.get("user_id") or payload.get("phone") or payload.get("caller_id")

    def _best(rows: list[dict], fields: tuple[str, ...]) -> dict | None:
        if not kws:
            return rows[0] if rows else None
        best, score = None, 0
        for r in rows:
            hay = " ".join(str(r.get(f) or "") for f in fields).lower()
            s = sum(1 for k in kws if k in hay)
            if s > score:
                best, score = r, s
        return best

    if content_type in ("research", "research_report"):
        q = client.table("research_reports_v2").select("topic,content")
        if user_id:
            q = q.eq("user_id", user_id)
        rows = getattr(await q.limit(200).execute(), "data", None) or []
        m = _best(rows, ("topic",))
        return None if not m else {"content_type": "research_report", "title": str(m.get("topic") or term),
                                   "content_text": str(m.get("content") or "")}
    # No strict content_type filter: the DB stores blog_post / short_story while the request/assertion
    # says "blog" / "short story" — the keyword match disambiguates, and the routed content_type label
    # is what the op reports back.
    q = client.table("published_content_v2").select("title,content_text,content_type")
    if user_id:
        q = q.eq("user_id", user_id)
    rows = getattr(await q.limit(200).execute(), "data", None) or []
    m = _best(rows, ("title", "content_text"))
    return None if not m else {"content_type": str(m.get("content_type") or content_type or "content"),
                               "title": str(m.get("title") or term), "content_text": str(m.get("content_text") or "")}


async def _op_eve_callback(payload: dict) -> dict:
    """E2E-5 (CR-010 A1): pull up a piece of content and call the user back to review/brainstorm it.

    Resolves the content, then (if found) runs the WF-16 Eve flow — KB cleanup → upload → first_message
    → outbound call → greeting reset — via the GATED ElevenLabs client (a dry run unless an agent is
    configured, so the baseline-protected PROD agent is never touched). Not-found → the callback is NOT
    placed (V30)."""
    from writer_engine.eve import run_eve_callback

    callback_mode = str(payload.get("callback_mode") or "review").lower()
    if callback_mode not in ("review", "brainstorm"):
        callback_mode = "review"
    phone = str(payload.get("phone") or payload.get("caller_id") or payload.get("user_id") or "")

    content_type = str(payload.get("content_type") or "")
    content_title = str(payload.get("content_title") or "")
    content_text = str(payload.get("content_text") or "")
    if not content_text:
        resolved = await _resolve_callback_content(payload)
        if not resolved:
            logger.info("eve.callback.not_found", search=payload.get("search_term"))
            return {"invoked": False, "found": False,
                    "message": "I couldn't find that to pull up, so there's nothing to call you back about."}
        content_type = content_type or resolved["content_type"]
        content_title = resolved["title"]
        content_text = resolved["content_text"]

    # resolve_only (V30): the hub pre-checks existence synchronously and only queues the real callback
    # when found — so a not-found request returns kind=data with NO job and NO ElevenLabs/outbound call.
    if payload.get("resolve_only"):
        return {"found": True, "callback_mode": callback_mode, "phone": phone,
                "content_type": content_type, "content_title": content_title, "content_text": content_text}

    eve = await run_eve_callback(
        content_type=content_type, content_title=content_title, content_text=content_text,
        callback_mode=callback_mode, phone=phone,
    )
    return {
        "invoked": True, "found": True, "callback_mode": callback_mode, "phone": phone,
        "content_type": content_type, "content_title": content_title, "eve": eve,
    }


async def _op_eve_reset_greeting(payload: dict) -> dict:
    """Reset the agent greeting after the callback (best-effort, gated like the callback)."""
    from writer_engine.eve import EveClient, eve_config, is_configured

    if not is_configured():
        return {"agent_id": payload.get("agent_id"), "reset": False, "dry_run": True}
    try:
        await EveClient(eve_config()).set_first_message("review", "your writing")
        return {"agent_id": eve_config()["agent_id"], "reset": True}
    except Exception as exc:
        logger.warning("eve.reset.failed", error=str(exc)[:160])
        return {"reset": False, "error": str(exc)[:160]}


OPS = {"email": _op_email, "eve-callback": _op_eve_callback, "eve-reset-greeting": _op_eve_reset_greeting}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "email")
    if op not in OPS:
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={"code": "UNKNOWN_OP", "message": op},  # type: ignore[arg-type]
        )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": await OPS[op](inp.payload)},
    )


app = build_step_app(STEP_NAME, handler)
