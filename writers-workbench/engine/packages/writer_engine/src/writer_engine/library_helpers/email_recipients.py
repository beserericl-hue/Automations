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


async def load_app_config(client, keys, user_id=None) -> dict[str, str]:
    """Load ``app_config_v2`` key→value for the given keys, scoped to ``user_id`` when supplied.

    G2: the engine previously queried a table named ``app_config``; DEV/PROD Supabase actually have
    ``app_config_v2``, and it is PER-USER (the ``recipient_email`` row differs per account). So the
    lookup silently failed and every email fell back to ``users_v2.email``. This reads the correct,
    user-scoped table: a user-scoped value wins over a global (null user_id) one for the same key."""
    import contextlib

    cfg: dict[str, str] = {}
    global_cfg: dict[str, str] = {}
    with contextlib.suppress(Exception):
        rows = await client.table("app_config_v2").select("key,value,user_id").in_("key", list(keys)).execute()
        for r in getattr(rows, "data", None) or []:
            if not r.get("value"):
                continue
            if user_id and str(r.get("user_id")) == str(user_id):
                cfg[r["key"]] = r["value"]
            elif not r.get("user_id"):
                global_cfg[r["key"]] = r["value"]
    return {**global_cfg, **cfg}  # user-scoped overrides global


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
