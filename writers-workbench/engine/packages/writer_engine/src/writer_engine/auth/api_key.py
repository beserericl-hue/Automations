"""Stub API-key dependency for /v1 routes. Real Argon2id-hashed lookup arrives with B2B (Sprint 23+).

For F0 we accept any non-empty key — the route is wired so it 401s without a key, and the look-up plug-in is
clearly marked. Replaced in F4/Phase F.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, HTTPException, status


@dataclass(frozen=True)
class ApiKeyIdentity:
    key_prefix: str
    tenant_id: str = "tenant-stub"


def require_api_key(x_api_key: str | None = Header(default=None)) -> ApiKeyIdentity:
    """Reject missing keys with 401. Real validation arrives in the B2B phase."""
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing X-Api-Key")
    if len(x_api_key) < 16:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid X-Api-Key")
    return ApiKeyIdentity(key_prefix=x_api_key[:6])
