"""Hold mail to the regression-test inbox while a regression run is going.

The DEV regression suite signs in as a real account (Eric's) and drives real jobs, so every
"chapter is ready", approve / delete / restore notice and research report it triggers landed in that
account's inbox, about sixty per run (Eric, 2026-11-08: "stop sending the test emails, for tests only").

The test runner (``e2e/runner/run.sh``) writes one row, ``e2e_mail_hold``, into ``app_config_global_v2``
for the length of the run: ``{"until": "<ISO time>", "addresses": ["eric@..."]}``. A send whose every
recipient is on that list is skipped here (and in the server's mailer) and reported as held. Mail to anyone
else, including a test subscriber, still goes out, and outside a run nothing is held. The row expires by
itself (``until``), so a runner that dies cannot leave the inbox muted.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime

import httpx

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("postal.test_hold")

KEY = "e2e_mail_hold"
_TTL_S = 20.0
_cache: tuple[float, frozenset[str]] | None = None


def parse_hold(value: str | None, now: datetime | None = None) -> frozenset[str]:
    """The held addresses in a stored value; empty when the row is absent, malformed or expired."""
    if not value:
        return frozenset()
    try:
        data = json.loads(value)
        until = datetime.fromisoformat(str(data["until"]).replace("Z", "+00:00"))
        if until.tzinfo is None:
            until = until.replace(tzinfo=UTC)
        if until <= (now or datetime.now(UTC)):
            return frozenset()
        return frozenset(str(a).strip().lower() for a in data.get("addresses") or [] if str(a).strip())
    except (ValueError, KeyError, TypeError):
        return frozenset()


async def held_addresses() -> frozenset[str]:
    """Addresses held right now. Read at most every 20 seconds; any failure means nothing is held."""
    global _cache
    if _cache and time.monotonic() - _cache[0] < _TTL_S:
        return _cache[1]
    s = get_settings()
    held: frozenset[str] = frozenset()
    if s.supabase_url and s.supabase_service_role_key:
        try:
            async with httpx.AsyncClient(timeout=5.0) as http:
                r = await http.get(
                    f"{s.supabase_url.rstrip('/')}/rest/v1/app_config_global_v2",
                    params={"key": f"eq.{KEY}", "select": "value"},
                    headers={
                        "apikey": s.supabase_service_role_key,
                        "authorization": f"Bearer {s.supabase_service_role_key}",
                    },
                )
            rows = r.json() if r.status_code == 200 else []
            if isinstance(rows, list) and rows:
                held = parse_hold(rows[0].get("value"))
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("test_hold.read_failed", error=str(exc)[:160])
    _cache = (time.monotonic(), held)
    return held


async def is_held(recipients: list[str]) -> bool:
    """True when there are recipients and every one is on the hold list."""
    addrs = [a.strip().lower() for a in recipients if a and a.strip()]
    if not addrs:
        return False
    held = await held_addresses()
    return bool(held) and all(a in held for a in addrs)


def reset_cache() -> None:
    global _cache
    _cache = None
