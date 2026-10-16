"""Tell a human when the engine is degraded (C2).

Nothing anywhere notified anyone when this system broke. The Redis instance died on 2026-05-19 and
took BullMQ and SSE with it for **nine days** before someone noticed by using the product. The
engine has had a real readiness endpoint since B2, but an endpoint only helps someone who is already
looking at it.

Scope, deliberately narrow:

* It alerts on a **transition** — the first check that finds a problem — not on every check, and it
  says so again only after ``ALERT_REPEAT_MINUTES``. A monitor that emails every 30 seconds while
  Redis is down is a monitor people filter into a folder.
* It alerts on **recovery** too, so an inbox tells the whole story without anyone logging in.
* The debounce state lives in Redis so N engine instances send ONE email, not N. When Redis is the
  thing that is down, the debounce degrades to per-process and the recipient may get one mail per
  instance — the right failure direction for the one outage that matters most.

What this CANNOT catch is the engine being entirely dead, because the watchdog is inside it. That
needs an external uptime check against ``/admin/health``; see docs. This covers the failure mode we
actually had — a container that is up and answering while a dependency underneath it is gone.
"""

from __future__ import annotations

import html
import socket
import time
from dataclasses import dataclass
from typing import Any

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("alerting")

# One Redis key per alert key, holding the last-sent timestamp.
_PREFIX = "engine:alert:last-sent"

LEVEL_WARNING = "warning"
LEVEL_CRITICAL = "critical"


@dataclass(frozen=True)
class Alert:
    """One thing worth waking up for."""

    key: str
    """Stable identity of the CONDITION, not of this occurrence — the debounce is keyed on it."""
    level: str
    title: str
    detail: str = ""
    context: dict[str, Any] | None = None


def _instance() -> str:
    """Which instance is reporting. With several instances up, "Redis is down" needs a source."""
    try:
        return socket.gethostname()
    except Exception:  # pragma: no cover
        return "unknown"


async def _should_send(key: str, repeat_after_s: float) -> bool:
    """True when this condition has not been reported within ``repeat_after_s``.

    Implemented with SET NX + EX so the check and the claim are one atomic operation: two instances
    noticing the same outage in the same second must not both decide they are the one to send.
    """
    try:
        from writer_engine.redis_client.client import get_redis

        client = await get_redis()
        claimed: Any = client.set(
            f"{_PREFIX}:{key}", str(time.time()), ex=max(1, int(repeat_after_s)), nx=True
        )
        return bool(await claimed)
    except Exception:
        # Redis unreachable. That is itself usually WHY we are alerting, so send: a duplicate email
        # is a nuisance, a suppressed one is the nine-day outage again.
        logger.warning("alerting.debounce_unavailable", key=key)
        return True


def _render(alert: Alert) -> tuple[str, str]:
    """(subject, html). Plain and scannable; the subject alone should be enough to triage."""
    settings = get_settings()
    env = settings.service_name or "writer-engine"
    subject = f"[{alert.level.upper()}] {env}: {alert.title}"
    rows = {
        "level": alert.level,
        "instance": _instance(),
        "service": env,
        **(alert.context or {}),
    }
    body = "".join(
        f"<tr><td style='padding:2px 10px 2px 0'><b>{html.escape(str(k))}</b></td>"
        f"<td style='padding:2px 0'>{html.escape(str(v))}</td></tr>"
        for k, v in rows.items()
    )
    detail = f"<pre style='white-space:pre-wrap'>{html.escape(alert.detail)}</pre>" if alert.detail else ""
    return subject, (
        f"<h3 style='margin:0 0 8px'>{html.escape(alert.title)}</h3>"
        f"<table style='font:13px/1.4 -apple-system,sans-serif'>{body}</table>{detail}"
    )


async def send_alert(alert: Alert, *, repeat_after_s: float | None = None, force: bool = False) -> bool:
    """Email an alert. Returns True if it was sent, False if suppressed or not configured.

    Never raises: an alerting failure must not become a second outage. Every outcome is logged, so a
    silent inbox can be distinguished from a silent system.
    """
    settings = get_settings()
    recipient = settings.alert_email.strip()
    # The log line is the fallback channel. An unconfigured recipient still leaves a record, which
    # is how someone discovers that alerting was never turned on.
    logger.warning(
        "alerting.alert",
        key=alert.key,
        level=alert.level,
        title=alert.title,
        detail=alert.detail[:400],
        **(alert.context or {}),
    )
    if not recipient:
        logger.warning("alerting.no_recipient", key=alert.key, hint="set ALERT_EMAIL")
        return False

    window = repeat_after_s if repeat_after_s is not None else settings.alert_repeat_minutes * 60
    if not force and not await _should_send(alert.key, window):
        return False

    try:
        from writer_engine.postal.client import PostalClient

        subject, body = _render(alert)
        client = PostalClient()
        result = await client.send(
            to=[recipient],
            from_addr=settings.newsletter_from_address,
            subject=subject,
            html=body,
            tag="engine-alert",
        )
        ok = str(getattr(result, "status", "") or "").lower() != "error"
        if not ok:
            logger.error("alerting.send_rejected", key=alert.key, result=str(result)[:200])
        return ok
    except Exception as exc:
        logger.error("alerting.send_failed", key=alert.key, error=f"{type(exc).__name__}: {str(exc)[:200]}")
        return False


async def clear_alert(key: str) -> None:
    """Forget a condition's debounce, so its next occurrence alerts immediately."""
    try:
        from writer_engine.redis_client.client import get_redis

        client = await get_redis()
        deleted: Any = client.delete(f"{_PREFIX}:{key}")
        await deleted
    except Exception:
        pass


__all__ = ["LEVEL_CRITICAL", "LEVEL_WARNING", "Alert", "clear_alert", "send_alert"]
