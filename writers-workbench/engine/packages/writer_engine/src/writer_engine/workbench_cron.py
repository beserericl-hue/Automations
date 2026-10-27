"""Drive the Workbench's own lifecycle crons from the engine's clock.

The Workbench server has had three correct cron routes since Sprint 8 —
``/api/cron/trial-check``, ``/api/cron/credit-reset`` and ``/api/cron/trial-warnings`` — and on DEV
**nothing has ever called them**, for two compounding reasons:

* ``CRON_SECRET`` was unset, so `requireSharedSecret` answered 500 `MISCONFIGURED` to anyone who
  tried (correctly failing closed, but failing);
* nothing was scheduled against them in the first place. They were built for an external caller
  that was never wired up, and the n8n workflows that might have done it are deactivated.

The visible consequence on DEV: **trials never expire, monthly credits never reset, and no trial
warning emails go out.** None of that fails loudly — a cron nobody calls looks exactly like a cron
with nothing to do, which is the same failure mode as the n8n multi-user cron that "succeeded" every
30 minutes for months while uploading nothing.

So the engine drives them, for the same reason it drives ingestion and the newsletter cadence (E1):
it is the one process in this system that has a clock and is always running.

Hourly, not daily. These are date-boundary jobs, so an hourly tick means a trial that ends at 09:00
is expired by 10:00 rather than up to a day later, and each tick is three cheap indexed queries.
"""

from __future__ import annotations

from typing import Any

import httpx

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("workbench_cron")

TIMEOUT_S = 30.0

LIFECYCLE_PATHS: tuple[str, ...] = (
    # Order matters a little: expire first, then reset the survivors' credits, then warn whoever is
    # approaching an end date. Running them in the other order would warn accounts that were about
    # to be expired in the same tick.
    "/api/cron/trial-check",
    "/api/cron/credit-reset",
    "/api/cron/trial-warnings",
    # Sprint 9: bring Stripe-billed subscriptions back in line with Stripe (missed webhooks, ended
    # cancellations), retry paid reader print orders RPI has not taken, and remind trials 3 days out.
    "/api/cron/subscription-sync",
    "/api/cron/trial-conversion-reminder",
)


async def run_lifecycle(*, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """POST each lifecycle cron and report what happened. Never raises.

    Returns ``{"called": n, "results": {path: summary}, "skipped": reason}``. A missing URL or
    secret is reported as ``skipped`` rather than attempted, because a 500 from the other side would
    otherwise be indistinguishable from a configuration gap — which is exactly how this went
    unnoticed.
    """
    settings = get_settings()
    base = (settings.workbench_api_url or "").rstrip("/")
    secret = (settings.workbench_cron_secret or "").strip()
    if not base or not secret:
        missing = "WORKBENCH_API_URL" if not base else "WORKBENCH_CRON_SECRET"
        logger.warning("workbench_cron.not_configured", missing=missing)
        return {"called": 0, "results": {}, "skipped": f"{missing} not set"}

    owned = client is None
    http = client or httpx.AsyncClient(timeout=TIMEOUT_S)
    results: dict[str, Any] = {}
    called = 0
    try:
        for path in LIFECYCLE_PATHS:
            try:
                resp = await http.post(
                    f"{base}{path}",
                    headers={
                        "X-Cron-Secret": secret,
                        "Content-Type": "application/json",
                        # The Workbench host's WAF rejects the default client UA with a 403; the
                        # engine's other calls out to it carry this for the same reason.
                        "User-Agent": "curl/8",
                    },
                    json={},
                )
            except Exception as exc:
                results[path] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:160]}
                logger.warning("workbench_cron.call_failed", path=path, error=str(exc)[:160])
                continue
            called += 1
            if resp.status_code >= 400:
                results[path] = {"ok": False, "status": resp.status_code, "body": resp.text[:200]}
                logger.warning("workbench_cron.call_rejected", path=path, status=resp.status_code)
                continue
            try:
                body = resp.json()
            except Exception:
                body = {"raw": resp.text[:200]}
            data = body.get("data") if isinstance(body, dict) else None
            results[path] = {"ok": True, "data": data if data is not None else body}
            logger.info("workbench_cron.called", path=path, data=str(data)[:200])
    finally:
        if owned:
            await http.aclose()

    return {"called": called, "results": results}
