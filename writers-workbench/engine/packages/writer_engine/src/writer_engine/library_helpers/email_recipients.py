"""Resolve email recipient + bcc.

Mirrors the n8n tool-workflow convention (see MEMORY.md "Centralized email config"): the Supabase
``app_config`` key/value table holds ``recipient_email`` and ``bcc_email``; a per-request trigger
value overrides the config default when present. Each n8n tool fetched config independently because
``$('node')`` is null in ai_tool sub-nodes — this helper is the single Python equivalent.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Recipients:
    to: str | None
    bcc: str | None


def _clean(v: str | None) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def resolve_recipients(
    *,
    trigger_recipient: str | None = None,
    trigger_bcc: str | None = None,
    config: dict[str, str] | None = None,
) -> Recipients:
    """Resolve the effective ``to`` / ``bcc`` for an outbound email.

    Precedence: explicit trigger value > ``app_config`` value > None. ``config`` is the app_config
    map (e.g. ``{"recipient_email": "...", "bcc_email": "..."}``) the caller already loaded from
    Supabase. Blank strings are treated as absent.
    """
    cfg = config or {}
    to = _clean(trigger_recipient) or _clean(cfg.get("recipient_email"))
    bcc = _clean(trigger_bcc) or _clean(cfg.get("bcc_email"))
    return Recipients(to=to, bcc=bcc)
