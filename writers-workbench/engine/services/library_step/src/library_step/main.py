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


_LIFECYCLE_STATUS = {
    "approve": "approved", "publish": "published", "reject": "rejected",
    "unschedule": "draft", "draft": "draft", "delete": "deleted", "undelete": "draft",
    "schedule": "scheduled",
}


async def _op_lifecycle(payload: dict) -> dict:
    """Approve / publish / reject / schedule / unschedule / delete / undelete a piece of content, or
    list_deleted (the trash). n8n parity (manage_library): snapshot the current text into
    ``content_versions_v2`` before approve/publish/delete, flip the status, and email the user on
    approve/publish/reject/schedule/delete/undelete. ``draft`` / ``unschedule`` change status silently.
    A published item cannot be deleted (unpublish first). The target is resolved by ``content_id`` or,
    when absent, by ``title``/``search_term`` (delete/undelete by name). Best-effort email."""
    from datetime import datetime

    action = str(payload.get("action") or "approve").lower()
    user_id = payload.get("user_id")
    client = await _supabase_or_none()

    # list_deleted is a READ of the trash (no target row) — handle first.
    if action == "list_deleted":
        if client is None:
            return {"items": [], "fixture": True}
        q = client.table("published_content_v2").select(
            "id,title,status,content_type,chapter_number,updated_at"
        ).eq("status", "deleted")
        if user_id:
            q = q.eq("user_id", user_id)
        ctf = _clean_str(payload.get("content_type_filter") or payload.get("content_type"))
        if ctf:
            q = q.eq("content_type", ctf)
        rows = getattr(await q.limit(20).execute(), "data", None) or []
        return {"items": rows, "count": len(rows)}

    if action not in _LIFECYCLE_STATUS:
        return {"error": f"unknown action {action}"}
    new_status = _LIFECYCLE_STATUS[action]

    content_id = payload.get("content_id")
    if client is None:
        return {"id": content_id, "status": new_status}

    cols = "id,user_id,title,content_type,content_text,status,project_id,chapter_number,metadata,deleted_at"
    row = None
    if content_id:
        cur = await client.table("published_content_v2").select(cols).eq("id", content_id).limit(1).execute()
        rows = getattr(cur, "data", None) or []
        row = rows[0] if rows else None
    else:
        # Resolve by title/name (delete/undelete by name). Undelete searches the trash; others active rows.
        q = client.table("published_content_v2").select(cols)
        if user_id:
            q = q.eq("user_id", user_id)
        if action == "undelete":
            q = q.eq("status", "deleted")
        rows = getattr(await q.limit(200).execute(), "data", None) or []
        row = _best_match(rows, _clean_str(payload.get("title") or payload.get("search_term")), ("title",))
    if not row:
        return {"error": "content not found", "id": content_id}
    content_id = row["id"]
    row_user = row.get("user_id") or user_id

    # Published-delete guard (R95): a published item must be unpublished before it can be deleted.
    if action == "delete" and row.get("status") == "published":
        return {
            "error": "Cannot delete published content — unpublish it first.",
            "id": content_id, "status": "published",
        }

    # Snapshot before approve/publish/delete — the auto-version n8n took at these gates.
    if action in {"approve", "publish", "delete"} and row.get("content_text"):
        try:
            last = await (
                client.table("content_versions_v2").select("version_number")
                .eq("content_id", content_id).order("version_number", desc=True).limit(1).execute()
            )
            last_rows = getattr(last, "data", None) or []
            next_version = int((last_rows[0].get("version_number") if last_rows else 0) or 0) + 1
            note = "Auto-snapshot before delete" if action == "delete" else f"auto-snapshot before {action}"
            await client.table("content_versions_v2").insert({
                "content_id": content_id, "user_id": row_user, "version_number": next_version,
                "content_text": row.get("content_text"), "changed_by": f"lifecycle_{action}",
                "change_note": note,
            }).execute()
        except Exception as exc:  # snapshot is best-effort; never block the lifecycle change
            logger.warning("lifecycle.snapshot_failed", action=action, error=str(exc)[:200])

    updates: dict = {"status": new_status, "updated_at": datetime.now(UTC).isoformat()}
    meta = dict(row.get("metadata") or {})
    if action == "publish":
        updates["published_at"] = datetime.now(UTC).isoformat()
    if action == "delete":
        updates["deleted_at"] = datetime.now(UTC).isoformat()
    if action == "undelete":
        updates["deleted_at"] = None
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

    try:
        from writer_engine.notifications.task_email import send_lifecycle_email

        await send_lifecycle_email(client, row_user, {**row, **updates}, new_status, action)
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


# --------------------------------------------------------------------------- versions + revert (E2E-2)


async def _op_versions(payload: dict) -> dict:
    """List or get versions (E2E-2). scope=outline → outline_versions_v2 by project (resolved by title);
    scope=content → content_versions_v2 by content_id. mode=get returns one version's full body."""
    client = await _supabase_or_none()
    if client is None:
        return {"versions": [], "fixture": True}
    scope = _clean_str(payload.get("scope")).lower()
    mode = _clean_str(payload.get("mode")).lower() or "list"
    version_number = payload.get("version_number")
    user_id = payload.get("user_id")

    # outline scope: explicit, or no content_id given and an outline/project reference is present.
    if scope == "outline" or (not scope and not payload.get("content_id")):
        project_id = payload.get("project_id")
        if not project_id:
            term = _clean_str(payload.get("project_title") or payload.get("title") or payload.get("search_term"))
            pq = client.table("writing_projects_v2").select("id,title")
            if user_id:
                pq = pq.eq("user_id", user_id)
            pm = _best_match(getattr(await pq.limit(200).execute(), "data", None) or [], term, ("title",))
            if not pm:
                return {"error": f"project '{term}' not found", "versions": []}
            project_id = pm["id"]
        vq = (
            client.table("outline_versions_v2").select("version_number,outline,revision_note,created_at")
            .eq("project_id", project_id).order("version_number", desc=False)
        )
        vrows = getattr(await vq.limit(100).execute(), "data", None) or []
        if mode == "get" and version_number is not None:
            sel = next((v for v in vrows if int(v.get("version_number") or 0) == int(version_number)), None)
            if not sel:
                return {"error": f"version {version_number} not found", "versions": []}
            return {"version": sel}
        entries = [{
            "version_number": v.get("version_number"), "created_at": v.get("created_at"),
            "revision_note": v.get("revision_note"),
            "chapter_count": len((v.get("outline") or {}).get("chapters") or []),
        } for v in vrows]
        return {"scope": "outline", "project_id": project_id, "versions": entries, "count": len(entries)}

    # content scope
    content_id = payload.get("content_id")
    if not content_id:
        return {"error": "content_id required for content version history", "versions": []}
    vq = (
        client.table("content_versions_v2").select("version_number,changed_by,change_note,created_at,content_text")
        .eq("content_id", content_id).order("version_number", desc=False)
    )
    vrows = getattr(await vq.limit(100).execute(), "data", None) or []
    if mode == "get" and version_number is not None:
        sel = next((v for v in vrows if int(v.get("version_number") or 0) == int(version_number)), None)
        if not sel:
            return {"error": f"version {version_number} not found", "versions": []}
        return {"version": sel}
    entries = [{
        "version_number": v.get("version_number"), "changed_by": v.get("changed_by"),
        "change_note": v.get("change_note"), "created_at": v.get("created_at"),
    } for v in vrows]
    return {"scope": "content", "content_id": content_id, "versions": entries, "count": len(entries)}


async def _revert_chapter(client, payload: dict, version_number: int, user_id) -> dict:
    from datetime import datetime

    content_id = payload.get("content_id")
    if content_id:
        cur = getattr(
            await client.table("published_content_v2").select("content_text").eq("id", content_id).limit(1).execute(),
            "data", None,
        ) or []
        if not cur:
            return {"reverted": False, "error_message": "content not found"}
        current_text = cur[0].get("content_text")
    else:
        term = _clean_str(payload.get("project_title") or payload.get("title") or payload.get("search_term"))
        q = client.table("published_content_v2").select("id,title,content_text,chapter_number,content_type")
        if user_id:
            q = q.eq("user_id", user_id)
        q = q.eq("content_type", "chapter")
        ch = payload.get("chapter_number")
        if ch not in (None, ""):
            import contextlib

            with contextlib.suppress(TypeError, ValueError):
                q = q.eq("chapter_number", int(ch))
        match = _best_match(getattr(await q.limit(200).execute(), "data", None) or [], term, ("title",))
        if not match:
            return {"reverted": False, "error_message": "chapter not found"}
        content_id, current_text = match["id"], match.get("content_text")

    vrows = getattr(
        await client.table("content_versions_v2").select("version_number,content_text").eq("content_id", content_id).execute(),
        "data", None,
    ) or []
    target = next((v for v in vrows if int(v.get("version_number") or 0) == version_number), None)
    if not target:
        return {"reverted": False, "error_message": f"version {version_number} not found"}
    try:
        next_v = max((int(v.get("version_number") or 0) for v in vrows), default=0) + 1
        await client.table("content_versions_v2").insert({
            "content_id": content_id, "user_id": user_id, "version_number": next_v,
            "content_text": current_text, "changed_by": "revert",
            "change_note": f"pre-revert snapshot (to v{version_number})",
        }).execute()
    except Exception as exc:
        logger.warning("revert.snapshot_failed", scope="chapter", error=str(exc)[:200])
    await client.table("published_content_v2").update(
        {"content_text": target.get("content_text"), "updated_at": datetime.now(UTC).isoformat()}
    ).eq("id", content_id).execute()
    return {"reverted": True, "scope": "chapter", "content_id": content_id, "version": version_number}


async def _op_revert(payload: dict) -> dict:
    """Revert an outline (writing_projects_v2.outline) or a chapter (published_content_v2.content_text)
    to a prior version (E2E-2). Snapshots the CURRENT state before overwriting. A missing version or
    project leaves everything unmodified and returns an informative error (R90/R91)."""
    client = await _supabase_or_none()
    if client is None:
        return {"reverted": False, "error_message": "supabase not configured"}
    version_number = payload.get("version_number")
    if version_number in (None, ""):
        return {"reverted": False, "error_message": "version_number required"}
    version_number = int(version_number)
    user_id = payload.get("user_id")
    scope = _clean_str(payload.get("scope")).lower() or "outline"

    if scope == "chapter":
        return await _revert_chapter(client, payload, version_number, user_id)

    # outline revert
    project_id = payload.get("project_id")
    if project_id:
        cur = getattr(
            await client.table("writing_projects_v2").select("title,outline").eq("id", project_id).limit(1).execute(),
            "data", None,
        ) or []
        if not cur:
            return {"reverted": False, "error_message": "project not found"}
        current_outline, title = cur[0].get("outline") or {}, cur[0].get("title")
    else:
        term = _clean_str(payload.get("project_title") or payload.get("title") or payload.get("search_term"))
        pq = client.table("writing_projects_v2").select("id,title,outline")
        if user_id:
            pq = pq.eq("user_id", user_id)
        pm = _best_match(getattr(await pq.limit(200).execute(), "data", None) or [], term, ("title",))
        if not pm:
            return {"reverted": False, "error_message": f"project '{term}' not found"}
        project_id, current_outline, title = pm["id"], pm.get("outline") or {}, pm.get("title")

    vrows = getattr(
        await client.table("outline_versions_v2").select("version_number,outline").eq("project_id", project_id).execute(),
        "data", None,
    ) or []
    target = next((v for v in vrows if int(v.get("version_number") or 0) == version_number), None)
    if not target:
        return {"reverted": False, "error_message": f"version {version_number} not found for '{title}'"}
    target_outline = target.get("outline") or {}

    try:  # snapshot current outline BEFORE overwrite
        next_v = max((int(v.get("version_number") or 0) for v in vrows), default=0) + 1
        await client.table("outline_versions_v2").insert({
            "user_id": user_id, "project_id": project_id, "version_number": next_v,
            "outline": current_outline, "revision_note": f"pre-revert snapshot (to v{version_number})",
        }).execute()
    except Exception as exc:
        logger.warning("revert.snapshot_failed", scope="outline", error=str(exc)[:200])

    chapter_count = len(target_outline.get("chapters") or [])
    await client.table("writing_projects_v2").update(
        {"outline": target_outline, "chapter_count": chapter_count}
    ).eq("id", project_id).execute()
    return {
        "reverted": True, "scope": "outline", "project_id": project_id, "title": title,
        "version": version_number, "chapter_count": chapter_count,
    }


OPS = {
    "insert-draft": _op_insert_draft,
    "lifecycle": _op_lifecycle,
    "retrieve": _op_retrieve,
    "list-outlines": _op_list_outlines,
    "email-content": _op_email_content,
    "versions": _op_versions,
    "revert": _op_revert,
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
