"""``X-Service-Secret`` and ``X-Admin-Token`` FastAPI dependencies for /internal and /admin routes."""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("auth")


def _check(presented: str | None, expected: str, header_name: str) -> None:
    """Constant-time compare, failing CLOSED when no secret is configured (G3).

    The settings default for both secrets is now empty rather than a placeholder like
    "dev-service-secret-change-me" — a well-known default means any environment that forgets to set
    the variable accepts a secret that is public in this repo's history.

    An unconfigured secret therefore cannot be treated as "matches empty"; it is a server fault and
    returns 503, deliberately distinguished from the 401 for a wrong secret. The distinction is
    diagnosable rather than leaky: these are the internal and admin surfaces, not a public endpoint,
    and a misconfigured service that silently 401s every caller is painful to debug.
    """
    if not expected:
        logger.error("auth.not_configured", header=header_name)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"server auth not configured: {header_name} has no configured secret",
        )
    if not presented or not hmac.compare_digest(presented, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=f"missing or invalid {header_name}"
        )


def require_service_secret(x_service_secret: str | None = Header(default=None)) -> None:
    """Check the request carries the shared internal secret."""
    _check(x_service_secret, get_settings().service_shared_secret, "X-Service-Secret")


def require_admin_token(x_admin_token: str | None = Header(default=None)) -> None:
    """Same pattern for admin-only ops (queue depth, cache flush, prompt reload)."""
    _check(x_admin_token, get_settings().admin_token, "X-Admin-Token")
