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


USER_TABLE = "app_config_v2"
GLOBAL_TABLE = "app_config_global_v2"
"""Global (all-user) settings, migration 044. ``app_config_v2`` is per-user with a NOT NULL FK on
``user_id``, so a shared value could only be stored by copying it onto every account."""


async def _key_values(client, table: str, keys, user_id=None) -> dict[str, str]:
    import contextlib

    out: dict[str, str] = {}
    with contextlib.suppress(Exception):  # a missing table/column is "no values", never an error
        q = client.table(table).select("key,value").in_("key", list(keys))
        if user_id is not None:
            q = q.eq("user_id", str(user_id))
        rows = await q.execute()
        for r in getattr(rows, "data", None) or []:
            v = r.get("value")
            if v is not None and str(v).strip():
                out[str(r["key"])] = str(v)
    return out


async def load_config_layers(client, keys, user_id=None) -> tuple[dict[str, str], dict[str, str]]:
    """``(user_values, global_values)`` for ``keys``. Kept apart so a caller can slot its own
    user-level fallback (e.g. ``users_v2.email``) in ahead of the global value."""
    user = await _key_values(client, USER_TABLE, keys, user_id) if user_id else {}
    glob = await _key_values(client, GLOBAL_TABLE, keys)
    return user, glob


async def load_app_config(client, keys, user_id=None, defaults=None) -> dict[str, str]:
    """Resolve ``keys`` as user -> global -> default.

    G2: the engine once queried a table named ``app_config``; the real one is ``app_config_v2`` and it
    is PER-USER (the ``recipient_email`` row differs per account). Item 8 (2026-11-02) adds the global
    scope: ``app_config_global_v2`` holds values every user inherits unless they set their own."""
    user, glob = await load_config_layers(client, keys, user_id)
    return {**(defaults or {}), **glob, **user}


async def load_recipient_config(client, user_id=None) -> dict[str, str]:
    """``recipient_email`` / ``bcc_email`` for ``user_id``: the user's setting, then their account
    email (still THEIR address, so it outranks any global value), then the global setting.

    A global ``recipient_email`` therefore only reaches users with no address of their own, while a
    global ``bcc_email`` (an operator copy) applies to everyone who has not set a bcc."""
    import contextlib

    user, glob = await load_config_layers(client, ["recipient_email", "bcc_email"], user_id)
    if user_id and not user.get("recipient_email"):
        with contextlib.suppress(Exception):
            ur = (
                await client.table("users_v2")
                .select("email,bcc_email")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            row = (getattr(ur, "data", None) or [{}])[0]
            if row.get("email"):
                user["recipient_email"] = str(row["email"])
            if row.get("bcc_email") and not user.get("bcc_email"):
                user["bcc_email"] = str(row["bcc_email"])
    return {**glob, **user}


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
