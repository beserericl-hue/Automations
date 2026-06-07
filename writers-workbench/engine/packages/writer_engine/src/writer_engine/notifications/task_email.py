"""CR-009 — email the result + task metadata when an engine write task completes (n8n parity).

Every n8n writing workflow emailed its result on completion (recipient from the per-user record or the
``app_config`` recipient_email/bcc_email). The engine has the transport (Postal + notify_step) but no
write tool invoked it, so engine tasks completed silently. This module is the single completion-email
builder, called from the arq worker after any load-bearing write tool finishes. Best-effort: a mail
failure must never affect the job.
"""

from __future__ import annotations

import contextlib
from html import escape
from typing import Any

from writer_engine.config import get_settings
from writer_engine.library_helpers.email_recipients import resolve_recipients
from writer_engine.postal import send_email
from writer_engine.telemetry.logging import get_logger

logger = get_logger("task_email")

# Tools whose completion produces a user-facing artifact worth emailing.
_EMAIL_TOOLS = {"chapter", "brainstorm", "research", "media"}
_LABELS = {"chapter": "Chapter", "brainstorm": "Outline", "research": "Research report", "media": "Media"}
_BODY_SNIPPET_CHARS = 20000  # cap the inlined prose so the email isn't enormous


async def _load_recipients(client: Any, user_id: str | None):
    """Per-user email (users_v2) takes precedence, then app_config recipient_email/bcc_email."""
    cfg: dict[str, str] = {}
    with contextlib.suppress(Exception):
        rows = await client.table("app_config").select("key,value").in_(
            "key", ["recipient_email", "bcc_email"]
        ).execute()
        for r in getattr(rows, "data", None) or []:
            if r.get("value"):
                cfg[r["key"]] = r["value"]
    user_email = None
    if user_id:
        with contextlib.suppress(Exception):
            ur = await client.table("users_v2").select("email,bcc_email").eq(
                "user_id", user_id
            ).limit(1).execute()
            row = (getattr(ur, "data", None) or [{}])[0]
            user_email = row.get("email")
            if row.get("bcc_email"):
                cfg.setdefault("bcc_email", row["bcc_email"])
    return resolve_recipients(trigger_recipient=user_email, config=cfg)


def build_task_email(tool: str, body: dict, result: dict) -> tuple[str, str]:
    """Return (subject, html) for a completed task — result data + the metadata block."""
    op = str(body.get("op") or "")
    chapter = body.get("chapter_number")
    project = body.get("project_title") or body.get("project_id") or "your project"
    label = _LABELS.get(tool, tool.title())
    what = f"{label} {chapter}".strip() if chapter is not None else label
    subject = f"[Writer's Workbench] {what} — {project} is ready"

    drift = result.get("drift_report") or {}
    qa = result.get("craft_qa") or {}
    qa_vals = [v for v in qa.values() if isinstance(v, (int, float))]
    qa_avg = round(sum(qa_vals) / len(qa_vals), 2) if qa_vals else None
    tok = result.get("token_usage") or {}
    research_used = result.get("research_used") or result.get("research_gaps_filled") or []
    command = body.get("directive") or body.get("originalUserPrompt") or body.get("message") or ""

    meta = [
        ("Task", f"{tool}.{op}" if op else tool),
        ("Project", project),
        ("Chapter", chapter) if chapter is not None else None,
        ("Words", f"{result.get('word_count'):,}") if result.get("word_count") else None,
        ("Aligned to outline", drift.get("aligned")) if drift else None,
        ("Craft QA", qa_avg) if qa_avg is not None else None,
        ("Research used", ", ".join(map(str, research_used))) if research_used else None,
        ("Tokens", f"{tok.get('total_tokens'):,} (${tok.get('cost_usd')})") if tok.get("total_tokens") else None,
        ("Your request", command) if command else None,
    ]
    rows_html = "".join(
        f"<tr><td style='padding:2px 12px 2px 0;color:#666'>{escape(str(k))}</td>"
        f"<td style='padding:2px 0'>{escape(str(v))}</td></tr>"
        for item in meta if item for k, v in [item]
    )
    html = (
        f"<h2 style='font-family:system-ui,sans-serif'>{escape(what)} is ready</h2>"
        f"<table style='font-family:system-ui,sans-serif;font-size:14px'>{rows_html}</table>"
    )
    prose = result.get("content_text") or result.get("content") or ""
    if prose:
        snippet = prose[:_BODY_SNIPPET_CHARS] + ("\n\n… (truncated; open in the Workbench for the full text)"
                                                 if len(prose) > _BODY_SNIPPET_CHARS else "")
        html += (
            "<hr><div style='font-family:Georgia,serif;font-size:15px;line-height:1.6;"
            f"white-space:pre-wrap'>{escape(snippet)}</div>"
        )
    return subject, html


async def send_task_completion_email(tool: str, body: dict, result: dict | None) -> bool:
    """Email the configured recipient that ``tool`` finished. Returns True if a mail was sent.
    Best-effort and opt-out-able (``body['notify'] is False``)."""
    if tool not in _EMAIL_TOOLS or not result or body.get("notify") is False:
        return False
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return False
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        rec = await _load_recipients(client, body.get("user_id"))
        if not rec.to:
            logger.info("task_email.no_recipient", tool=tool, chapter=body.get("chapter_number"))
            return False
        subject, html = build_task_email(tool, body, result)
        res = await send_email(
            to=[rec.to], from_addr=settings.newsletter_from_address, subject=subject, html=html,
            bcc=[rec.bcc] if rec.bcc else None,
        )
        logger.info("task_email.sent", to=rec.to, tool=tool, chapter=body.get("chapter_number"),
                    message_id=getattr(res, "message_id", None))
        return True
    except Exception as exc:  # never let a mail failure touch the job
        logger.warning("task_email.failed", tool=tool, error=str(exc)[:200])
        return False
