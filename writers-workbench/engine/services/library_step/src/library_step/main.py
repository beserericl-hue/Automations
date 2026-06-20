"""library-step — content lifecycle CRUD: insert / approve / publish / reject / schedule / retrieve / versions."""

from __future__ import annotations

import re
from datetime import UTC

from writer_engine.config import get_settings
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app
from writer_engine.telemetry.logging import get_logger

STEP_NAME = "library"
logger = get_logger("library_step")


async def _supabase_or_none():
    s = get_settings()
    if not s.supabase_url:
        return None
    from writer_engine.supabase.client import get_supabase_admin

    return await get_supabase_admin()


async def _op_insert_draft(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"id": "local-draft", **payload, "status": "draft"}
    resp = await client.table("published_content_v2").insert({**payload, "status": "draft"}).execute()
    return (getattr(resp, "data", None) or [{}])[0]


async def _op_lifecycle(payload: dict) -> dict:
    """Approve / publish / reject / schedule / unschedule a piece of content.

    n8n parity (manage_library): on approve/publish snapshot the current text into
    ``content_versions_v2`` first (so the state before the lifecycle change is reversible), then flip
    the status, and email the user on approve/publish/reject/schedule. ``draft`` (back-to-draft) and
    ``unschedule`` change status silently. Best-effort email — never blocks the DB write."""
    from datetime import datetime

    action = str(payload.get("action") or "approve")
    content_id = payload.get("content_id")
    user_id = payload.get("user_id")
    valid = {"approve", "publish", "reject", "schedule", "unschedule", "draft"}
    if action not in valid:
        return {"error": f"unknown action {action}"}
    new_status = {
        "approve": "approved", "publish": "published", "reject": "rejected",
        "unschedule": "draft", "draft": "draft",
    }.get(action, "scheduled")
    client = await _supabase_or_none()
    if client is None:
        return {"id": content_id, "status": new_status}

    # Load the current row so we can snapshot it (approve/publish) and email with its title/type.
    cur = await (
        client.table("published_content_v2")
        .select("id,user_id,title,content_type,content_text,status,project_id,chapter_number,metadata")
        .eq("id", content_id).limit(1).execute()
    )
    rows = getattr(cur, "data", None) or []
    if not rows:
        return {"error": "content not found", "id": content_id}
    row = rows[0]
    row_user = row.get("user_id") or user_id

    # Snapshot before mutating on approve/publish — the auto-version n8n took at these gates.
    if action in {"approve", "publish"} and row.get("content_text"):
        try:
            last = await (
                client.table("content_versions_v2").select("version_number")
                .eq("content_id", content_id).order("version_number", desc=True).limit(1).execute()
            )
            last_rows = getattr(last, "data", None) or []
            next_version = int((last_rows[0].get("version_number") if last_rows else 0) or 0) + 1
            await client.table("content_versions_v2").insert({
                "content_id": content_id, "user_id": row_user, "version_number": next_version,
                "content_text": row.get("content_text"), "changed_by": f"lifecycle_{action}",
                "change_note": f"auto-snapshot before {action}",
            }).execute()
        except Exception as exc:  # snapshot is best-effort; never block the lifecycle change
            logger.warning("lifecycle.snapshot_failed", action=action, error=str(exc)[:200])

    updates: dict = {"status": new_status, "updated_at": datetime.now(UTC).isoformat()}
    meta = dict(row.get("metadata") or {})
    if action == "publish":
        updates["published_at"] = datetime.now(UTC).isoformat()
    if action == "schedule" and payload.get("schedule_date"):
        meta["schedule_date"] = payload["schedule_date"]
        updates["metadata"] = meta
    if action == "unschedule" and "schedule_date" in meta:
        meta.pop("schedule_date", None)
        updates["metadata"] = meta

    resp = await (
        client.table("published_content_v2").update(updates).eq("id", content_id).execute()
    )
    out = (getattr(resp, "data", None) or [{**row, **updates}])[0]

    # Email the user (approve/publish/reject/schedule) — best-effort, mirrors n8n's Gmail node.
    try:
        from writer_engine.notifications.task_email import send_lifecycle_email

        await send_lifecycle_email(client, row_user, {**row, **updates}, new_status)
    except Exception as exc:
        logger.warning("lifecycle.email_failed", action=action, error=str(exc)[:200])
    return out


async def _op_retrieve(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"items": [], "fixture": True}
    q = client.table("published_content_v2").select(
        "id,title,status,content_type,project_id,chapter_number,created_at"
    )
    # project_id scopes the query to one project (the UI's project view); content_type narrows it
    # (e.g. just chapters). When a project_id is given, order by chapter so the UI lists them in order.
    if payload.get("project_id"):
        q = q.eq("project_id", payload["project_id"])
    if payload.get("user_id"):
        q = q.eq("user_id", payload["user_id"])
    if payload.get("content_type"):
        q = q.eq("content_type", payload["content_type"])
    if payload.get("status"):
        q = q.eq("status", payload["status"])
    if payload.get("project_id"):
        q = q.order("chapter_number", desc=False)
    resp = await q.limit(int(payload.get("limit") or 50)).execute()
    return {"items": getattr(resp, "data", None) or []}


async def _op_list_outlines(payload: dict) -> dict:
    client = await _supabase_or_none()
    if client is None:
        return {"items": []}
    resp = await (
        client.table("writing_projects_v2")
        .select("id,title,outline")
        .neq("outline", "{}")
        .limit(int(payload.get("limit") or 50))
        .execute()
    )
    return {"items": getattr(resp, "data", None) or []}


# --------------------------------------------------------------------------- email-content (E2E-1)

# Words that carry no signal when keyword-matching a free-text "email me the X about Y" request.
_EMAIL_STOP = {
    "the", "a", "an", "of", "for", "about", "on", "in", "me", "my", "email", "e-mail", "please",
    "send", "with", "and", "to", "story", "short", "research", "report", "newsletter", "chapter",
    "outline", "titled", "title", "this", "that", "named",
}


def _clean_str(v: object) -> str:
    return str(v or "").strip()


def _keywords(term: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9']+", term.lower()) if w not in _EMAIL_STOP and len(w) > 2]


def _best_match(rows: list[dict], term: str, fields: tuple[str, ...]) -> dict | None:
    """Pick the row whose ``fields`` best cover the term's keywords. Falls back to the most recent row
    only when the term is empty; a non-empty term that matches nothing returns None (→ not-found)."""
    kws = _keywords(term)
    if not kws:
        return rows[0] if rows else None
    best, best_score = None, 0
    for row in rows:
        hay = " ".join(_clean_str(row.get(f)) for f in fields).lower()
        score = sum(1 for kw in kws if kw in hay)
        if score > best_score:
            best, best_score = row, score
    return best


def _render_outline_md(outline: dict, title: str) -> str:
    """Render an outline JSONB to readable markdown (premise + characters + chapters), not raw JSON."""
    o = outline or {}
    lines = [f"# {o.get('title') or title or 'Outline'}", ""]
    if o.get("premise"):
        lines += [str(o["premise"]), ""]
    if o.get("story_arc_name"):
        lines += [f"**Story arc:** {o['story_arc_name']}", ""]
    chars = o.get("characters") or []
    if chars:
        lines += ["## Characters", ""]
        for c in chars:
            if isinstance(c, dict):
                lines.append(f"- **{c.get('name', 'Unnamed')}** — {c.get('description', c.get('role', ''))}")
        lines.append("")
    chapters = o.get("chapters") or []
    if chapters:
        lines += ["## Chapters", ""]
        for ch in chapters:
            if isinstance(ch, dict):
                num = ch.get("chapter_number", "")
                lines.append(f"{num}. **{ch.get('title', '')}** — {ch.get('beat', ch.get('summary', ''))}")
        lines.append("")
    return "\n".join(lines)


async def _email_recipients(client, explicit: str | None, user_id: str | None):
    """Resolve to/bcc for email-content. Precedence: explicit ("send it to X") > app_config.recipient_email
    > users_v2.email (last resort). BCC from app_config.bcc_email. Mirrors the centralized-email rule."""
    import contextlib

    from writer_engine.library_helpers.email_recipients import resolve_recipients

    cfg: dict[str, str] = {}
    with contextlib.suppress(Exception):
        rows = await client.table("app_config").select("key,value").in_(
            "key", ["recipient_email", "bcc_email"]
        ).execute()
        for r in getattr(rows, "data", None) or []:
            if r.get("value"):
                cfg[r["key"]] = r["value"]
    rec = resolve_recipients(trigger_recipient=_clean_str(explicit) or None, config=cfg)
    if not rec.to and user_id:
        with contextlib.suppress(Exception):
            ur = await client.table("users_v2").select("email").eq("user_id", user_id).limit(1).execute()
            row = (getattr(ur, "data", None) or [{}])[0]
            if row.get("email"):
                from writer_engine.library_helpers.email_recipients import Recipients

                return Recipients(to=row["email"], bcc=rec.bcc)
    return rec


async def _resolve_artifact(
    client, content_type: str, term: str, chapter_number, user_id: str | None
) -> tuple[str, str] | None:
    """Resolve an existing artifact → (markdown_body, subject). None when nothing matches (not-found)."""
    if content_type == "outline":
        q = client.table("writing_projects_v2").select("title,outline").neq("outline", "{}")
        if user_id:
            q = q.eq("user_id", user_id)
        rows = getattr(await q.limit(200).execute(), "data", None) or []
        match = _best_match(rows, term, ("title",))
        if not match:
            return None
        return _render_outline_md(match.get("outline") or {}, match.get("title") or term), \
            f"{match.get('title') or term} — Outline"

    if content_type == "research":
        q = client.table("research_reports_v2").select("topic,content")
        if user_id:
            q = q.eq("user_id", user_id)
        rows = getattr(await q.limit(200).execute(), "data", None) or []
        match = _best_match(rows, term, ("topic",))
        if not match:
            return None
        return _clean_str(match.get("content")), f"Research Report — {match.get('topic') or term}"

    # chapter / short_story / newsletter / blog → published_content_v2
    q = client.table("published_content_v2").select("title,content_text,content_type,chapter_number")
    if user_id:
        q = q.eq("user_id", user_id)
    if content_type:
        q = q.eq("content_type", content_type)
    if content_type == "chapter" and chapter_number not in (None, ""):
        import contextlib

        with contextlib.suppress(TypeError, ValueError):
            q = q.eq("chapter_number", int(chapter_number))
    rows = getattr(await q.limit(200).execute(), "data", None) or []
    match = _best_match(rows, term, ("title", "content_text"))
    if not match:
        return None
    if match.get("content_type") == "chapter" and match.get("chapter_number") not in (None, ""):
        subject = f"Chapter {match['chapter_number']} — {match.get('title') or term}"
    else:
        subject = _clean_str(match.get("title")) or term or "Your content"
    return _clean_str(match.get("content_text")), subject


async def _op_email_content(payload: dict) -> dict:
    """E2E-1 (CR-010 A2): email content to the user on demand. Two modes:

    * INLINE — the message supplied the body (``content``) + optional ``subject``/``recipient``: render
      markdown→HTML and send as-is.
    * RESOLVE — email an EXISTING artifact: ``content_type`` (outline/short_story/chapter/newsletter/
      research/blog) + ``title``/``search_term`` (+ ``chapter_number``) → load from
      ``writing_projects_v2`` (outline) / ``research_reports_v2`` (research) / ``published_content_v2``
      (everything else), render, send.

    Recipient precedence: explicit "send it to X" > ``app_config.recipient_email`` > ``users_v2.email``;
    BCC from ``app_config.bcc_email``. Not-found returns ``{emailed:false, error_message}`` with NO mail."""
    user_id = payload.get("user_id")
    subject = _clean_str(payload.get("subject"))
    inline = _clean_str(payload.get("content") or payload.get("content_text"))
    content_type = _clean_str(payload.get("content_type")).lower().replace(" ", "_").replace("-", "_")
    term = _clean_str(payload.get("title") or payload.get("search_term"))
    chapter_number = payload.get("chapter_number")

    client = await _supabase_or_none()
    if client is None:
        return {"emailed": False, "error_message": "supabase not configured"}

    if inline:
        body_md, subject = inline, (subject or "Writer's Workbench — Email")
        label = "inline"
    else:
        resolved = await _resolve_artifact(client, content_type, term, chapter_number, user_id)
        if not resolved:
            return {
                "emailed": False,
                "error_message": f"Couldn't find {content_type or 'content'} matching '{term}'. No email sent.",
            }
        body_md, default_subject = resolved
        subject = subject or default_subject
        label = content_type or "content"

    rec = await _email_recipients(client, payload.get("recipient"), user_id)
    if not rec.to:
        return {"emailed": False, "error_message": "no recipient configured (app_config.recipient_email)"}

    from writer_engine.library_helpers.markdown_html import markdown_to_html as _md_to_html
    from writer_engine.postal import send_email

    html = _md_to_html(body_md)
    settings = get_settings()
    try:
        res = await send_email(
            to=[rec.to], from_addr=settings.newsletter_from_address, subject=subject, html=html,
            bcc=[rec.bcc] if rec.bcc else None,
        )
    except Exception as exc:
        logger.warning("email_content.send_failed", error=str(exc)[:200])
        return {"emailed": False, "error_message": f"email send failed: {str(exc)[:160]}"}
    logger.info("email_content.sent", to=rec.to, label=label, subject=subject[:80],
                message_id=getattr(res, "message_id", None))
    return {"emailed": True, "to": rec.to, "subject": subject, "content_type": label}


OPS = {
    "insert-draft": _op_insert_draft,
    "lifecycle": _op_lifecycle,
    "retrieve": _op_retrieve,
    "list-outlines": _op_list_outlines,
    "email-content": _op_email_content,
}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "retrieve")
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
