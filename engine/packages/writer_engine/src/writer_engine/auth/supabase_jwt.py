"""Optional Supabase-JWT verification dependency for direct-from-browser routes.

The recommended F0/F2 path keeps the Workbench Express server as the UI gateway (it already validates the JWT and
holds the SSE channel) and the engine itself only sees the shared-secret /internal calls. This dependency exists
for the future direct-call mode and for any test fixtures that mint a Supabase JWT.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass

from fastapi import Header, HTTPException, status


@dataclass(frozen=True)
class JwtIdentity:
    user_id: str
    email: str | None


def _b64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode())


def require_supabase_jwt(authorization: str | None = Header(default=None)) -> JwtIdentity:
    """Decode without verifying signature — verification is added when this path is enabled.

    F0 keeps this OFF by routing through Express. Marked clearly so we do not accidentally trust it.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = authorization.split(" ", 1)[1]
    parts = token.split(".")
    if len(parts) != 3:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="malformed jwt")
    try:
        payload = json.loads(_b64url_decode(parts[1]))
    except Exception as exc:  # pragma: no cover — defensive
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="undecodable jwt") from exc
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="jwt missing sub")
    return JwtIdentity(user_id=str(user_id), email=payload.get("email"))
