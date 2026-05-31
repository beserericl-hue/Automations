"""``X-Service-Secret`` and ``X-Admin-Token`` FastAPI dependencies for /internal and /admin routes."""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from writer_engine.config import get_settings


def require_service_secret(x_service_secret: str | None = Header(default=None)) -> None:
    """Constant-time check the request carries the shared internal secret."""
    expected = get_settings().service_shared_secret
    if not x_service_secret or not hmac.compare_digest(x_service_secret, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="missing or invalid X-Service-Secret"
        )


def require_admin_token(x_admin_token: str | None = Header(default=None)) -> None:
    """Same pattern for admin-only ops (queue depth, cache flush, prompt reload)."""
    expected = get_settings().admin_token
    if not x_admin_token or not hmac.compare_digest(x_admin_token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="missing or invalid X-Admin-Token"
        )
